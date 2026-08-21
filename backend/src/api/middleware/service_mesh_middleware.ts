/**
 * Fastify middleware for service mesh mTLS enforcement (issue #277)
 *
 * This middleware sits at the Fastify `onRequest` hook and:
 *
 *   1. Reads the client certificate from the TLS socket (`req.socket`), or –
 *      when running behind a TLS-terminating proxy / service-mesh sidecar –
 *      from the `X-Forwarded-Client-Cert` (XFCC) header used by Envoy.
 *   2. Delegates to `ServiceMeshPolicy.evaluate()` for full policy assessment.
 *   3. Attaches the `PolicyResult` to `request.meshIdentity` for downstream
 *      handlers to consume (e.g., for fine-grained authorisation).
 *   4. Returns `401 Unauthorized` when the policy is not satisfied.
 *
 * Configuration
 * ─────────────
 * The middleware is configured at startup via `ServiceMeshConfig`.  The same
 * instance is shared across all requests to avoid repeated SPIFFE-URI list
 * parsing and Prometheus label creation.
 *
 * Usage
 * ──────
 * ```ts
 * import { registerServiceMeshMiddleware } from './middleware/service_mesh_middleware.js';
 *
 * // Register globally (all routes require mTLS)
 * registerServiceMeshMiddleware(app, { mode: 'STRICT', allowedSpiffeUris: [] });
 *
 * // Or as a scoped preHandler for a subset of routes
 * app.register(async (scoped) => {
 *   scoped.addHook('preHandler', buildServiceMeshPreHandler({ mode: 'STRICT' }));
 *   scoped.get('/internal/...', handler);
 * });
 * ```
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { TLSSocket } from 'node:tls';
import type { PolicyResult, ServiceMeshConfig } from '../gateway/service_mesh.js';
import { getServiceMeshPolicy } from '../gateway/service_mesh.js';
import type { Registry } from 'prom-client';

// Extend FastifyRequest with the mesh identity attached by this middleware
declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The policy result from service-mesh mTLS evaluation.
     * Set by `buildServiceMeshPreHandler` when the middleware is registered.
     * `undefined` when the middleware is not installed on the route.
     */
    meshIdentity?: PolicyResult;
  }
}

/**
 * Options accepted by `buildServiceMeshPreHandler` and
 * `registerServiceMeshMiddleware`.
 */
export interface ServiceMeshMiddlewareOptions {
  /**
   * Service mesh policy configuration.
   * Defaults mirror `ServiceMeshConfig` defaults (STRICT, no SPIFFE filter).
   */
  policy?: Partial<ServiceMeshConfig>;
  /**
   * Optional Prometheus registry override (for test isolation).
   */
  registry?: Registry;
  /**
   * When `true`, also honour the `X-Forwarded-Client-Cert` (XFCC) header
   * set by Envoy / Istio sidecars after TLS termination at the proxy layer.
   * Default: `true`.
   */
  trustXfccHeader?: boolean;
}

/**
 * Extract a PEM certificate from the Envoy `X-Forwarded-Client-Cert` header.
 *
 * XFCC format (from Envoy docs):
 * ```
 * By=spiffe://...,Hash=...,Cert="-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",...
 * ```
 * We extract only the `Cert=` field and URL-decode it.
 */
function extractCertFromXfcc(xfcc: string): string | null {
  // Cert= may be quoted or unquoted
  const match = /(?:^|,)Cert="([^"]+)"/.exec(xfcc) ?? /(?:^|,)Cert=([^,]+)/.exec(xfcc);
  if (match == null) return null;
  try {
    return decodeURIComponent(match[1] ?? '').replace(/\\n/g, '\n');
  } catch {
    return null;
  }
}

/**
 * Extract a PEM certificate from the raw TLS socket attached to the request.
 */
function extractCertFromSocket(request: FastifyRequest): string | null {
  const socket = request.socket as TLSSocket;
  if (typeof socket.getPeerCertificate !== 'function') return null;
  const peerCert = socket.getPeerCertificate(false);
  if (peerCert == null || peerCert.raw == null) return null;
  // `raw` is a Buffer (DER); node's X509Certificate accepts DER directly
  return peerCert.raw.toString('base64');
}

/**
 * Builds a Fastify `preHandler` that enforces the service-mesh mTLS policy.
 *
 * Returns a function compatible with `app.addHook('preHandler', ...)` or
 * `{ preHandler: [...] }` in a route definition.
 */
export function buildServiceMeshPreHandler(options: ServiceMeshMiddlewareOptions = {}) {
  const trustXfcc = options.trustXfccHeader ?? true;
  const policy = getServiceMeshPolicy(options.policy, options.registry);

  return async function serviceMeshPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    let rawCert: string | Buffer = '';

    // 1. Prefer XFCC header (sidecar-terminated TLS)
    if (trustXfcc) {
      const xfcc =
        typeof request.headers['x-forwarded-client-cert'] === 'string'
          ? request.headers['x-forwarded-client-cert']
          : undefined;
      if (xfcc != null && xfcc.length > 0) {
        rawCert = extractCertFromXfcc(xfcc) ?? '';
      }
    }

    // 2. Fall back to TLS socket peer cert (direct TLS, no proxy)
    if (rawCert === '') {
      rawCert = extractCertFromSocket(request) ?? '';
    }

    // 3. Evaluate policy
    const result = policy.evaluate({ raw: rawCert, peerAddress: request.ip });

    // 4. Attach to request for downstream handlers
    request.meshIdentity = result;

    if (!result.allowed) {
      request.log.warn(
        { reason: result.reason, ip: request.ip, serialNumber: result.serialNumber },
        'service-mesh mTLS: connection denied',
      );
      await reply.status(401).send({
        error: 'Unauthorized',
        message: result.reason ?? 'mTLS policy evaluation failed',
        code: 'MTLS_POLICY_DENIED',
      });
      return reply;
    }

    if (result.expiringSoon) {
      request.log.warn(
        {
          commonName: result.commonName,
          daysUntilExpiry: result.daysUntilExpiry,
          spiffeUri: result.spiffeUri,
        },
        'service-mesh mTLS: client certificate expiring soon',
      );
    }

    // Attach SPIFFE identity to response headers so downstream services can
    // log and correlate the caller identity without re-parsing the cert.
    if (result.spiffeUri != null) {
      void reply.header('X-Mesh-Spiffe-Uri', result.spiffeUri);
    }
  };
}

/**
 * Registers the service-mesh mTLS middleware as a global `onRequest` hook
 * on the Fastify instance.  Every route registered after this call will be
 * subject to mTLS policy evaluation.
 *
 * This is the recommended integration point for backend services that are
 * fully inside the mesh and must enforce STRICT mTLS on all endpoints.
 */
export function registerServiceMeshMiddleware(
  app: FastifyInstance,
  options: ServiceMeshMiddlewareOptions = {},
): void {
  const preHandler = buildServiceMeshPreHandler(options);
  app.addHook('preHandler', preHandler);
}
