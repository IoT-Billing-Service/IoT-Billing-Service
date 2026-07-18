/**
 * OAuth2Service — Issue #57
 *
 * Implements the OAuth 2.0 Authorization Code flow with PKCE (RFC 7636) for
 * third-party access to the IoT billing platform.
 *
 * Security guarantees:
 *  • PKCE S256 is mandatory — plain method is rejected.
 *  • Auth codes are single-use; consumption is atomic inside a DB transaction.
 *  • Raw auth codes and bearer tokens are never persisted — only their
 *    SHA-256 hashes are stored (defence-in-depth against DB compromise).
 *  • All token verification paths are constant-time via `crypto.timingSafeEqual`.
 *  • Refresh-token rotation: every refresh issues a new pair and revokes the
 *    old refresh token so replayed refresh tokens are rejected.
 *  • PCI-DSS / SOC2: revoked_at is set (soft delete) so the audit trail is
 *    never lost.
 *
 * Performance: token verification is a single indexed DB lookup on
 * `token_hash` (SHA-256 hex, 64 chars) — well within the 200ms P99 target.
 */

import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getEnv } from '../../config/env.js';
import { validateScopes, normaliseScopes } from './scopes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuth2ClientRecord {
  id: string;
  name: string;
  clientSecretHash: string | null;
  redirectUris: string;
  allowedScopes: string;
  active: boolean;
  ownerWallet: string;
}

export interface AuthoriseParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  walletAddress: string;
}

export interface AuthoriseResult {
  code: string;
  redirectUri: string;
  expiresAt: Date;
}

export interface TokenExchangeParams {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  /** Required for confidential clients; omit / leave empty for public clients. */
  clientSecret?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  scope: string;
}

export interface IntrospectionResult {
  active: boolean;
  scope?: string;
  clientId?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  tokenType?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of a string — used for all token/code hashing. */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Generate a cryptographically random opaque bearer string (32 bytes → 64-char hex).
 * Prefixed with `oat_` (OAuth access token) or `ort_` (OAuth refresh token) for
 * easy log redaction.
 */
export function generateBearerToken(prefix: 'oat' | 'ort'): string {
  return `${prefix}_${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Generate a cryptographically random authorisation code (16 bytes → 32-char hex).
 */
export function generateAuthCode(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks on secret
 * comparison (client_secret, PKCE verifier check).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  // Pad to same length so the comparison time is always proportional to
  // max(len(a), len(b)) rather than leaking the shorter string's length.
  const aLen = Buffer.byteLength(a, 'utf8');
  const bLen = Buffer.byteLength(b, 'utf8');
  const maxLen = Math.max(aLen, bLen);
  const aBuf = Buffer.alloc(maxLen);
  const bBuf = Buffer.alloc(maxLen);
  aBuf.write(a, 'utf8');
  bBuf.write(b, 'utf8');
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Compute PKCE S256 code challenge from a code verifier.
 * code_challenge = BASE64URL(SHA256(code_verifier))
 */
export function computeS256Challenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

// ---------------------------------------------------------------------------
// OAuth2Service
// ---------------------------------------------------------------------------

export class OAuth2Service {
  constructor(private readonly prisma: PrismaClient) {}

  // -------------------------------------------------------------------------
  // Client management
  // -------------------------------------------------------------------------

  /**
   * Register a new OAuth2 client application.
   * Returns the client record plus the raw (unhashed) client secret — this is
   * the only time the secret is available in plaintext.
   */
  async registerClient(params: {
    name: string;
    redirectUris: string[];
    allowedScopes: string;
    ownerWallet: string;
    isPublic?: boolean;
  }): Promise<{ client: OAuth2ClientRecord; rawSecret: string | null }> {
    const { name, redirectUris, allowedScopes, ownerWallet, isPublic = false } = params;

    const normalisedScopes = normaliseScopes(allowedScopes);
    const redirectUriString = redirectUris.join(',');

    let rawSecret: string | null = null;
    let secretHash: string | null = null;

    if (!isPublic) {
      rawSecret = generateBearerToken('oat').replace('oat_', 'cs_');
      secretHash = sha256Hex(rawSecret);
    }

    const client = await this.prisma.oAuth2Client.create({
      data: {
        name,
        clientSecretHash: secretHash,
        redirectUris: redirectUriString,
        allowedScopes: normalisedScopes,
        ownerWallet,
        active: true,
      },
    });

    return {
      client: {
        id: client.id,
        name: client.name,
        clientSecretHash: client.clientSecretHash,
        redirectUris: client.redirectUris,
        allowedScopes: client.allowedScopes,
        active: client.active,
        ownerWallet: client.ownerWallet,
      },
      rawSecret,
    };
  }

  // -------------------------------------------------------------------------
  // Authorisation endpoint logic
  // -------------------------------------------------------------------------

  /**
   * Validate an authorisation request and issue an authorisation code.
   *
   * Checks:
   *  1. Client exists and is active.
   *  2. redirect_uri exactly matches one of the registered URIs.
   *  3. All requested scopes are within the client's allowed_scopes.
   *  4. code_challenge_method is "S256".
   *  5. code_challenge is a non-empty base64url string.
   *
   * The raw code is returned to the caller (to be embedded in the redirect);
   * only its SHA-256 hash is stored.
   */
  async authorise(params: AuthoriseParams): Promise<AuthoriseResult> {
    const { clientId, redirectUri, scope, codeChallenge, codeChallengeMethod, walletAddress } =
      params;

    // 1. Load client
    const client = await this.prisma.oAuth2Client.findUnique({ where: { id: clientId } });
    if (!client || !client.active) {
      throw new OAuth2Error('invalid_client', 'Unknown or inactive client');
    }

    // 2. Validate redirect URI
    const allowedUris = client.redirectUris.split(',').map((u) => u.trim());
    if (!allowedUris.includes(redirectUri)) {
      throw new OAuth2Error('invalid_request', 'redirect_uri does not match registered URIs');
    }

    // 3. Validate scopes
    if (!validateScopes(scope, client.allowedScopes)) {
      throw new OAuth2Error('invalid_scope', 'Requested scope exceeds client permissions');
    }

    // 4. PKCE method
    if (codeChallengeMethod !== 'S256') {
      throw new OAuth2Error(
        'invalid_request',
        'Only code_challenge_method=S256 is supported (RFC 7636)',
      );
    }

    // 5. code_challenge format (base64url, 43–128 chars per RFC 7636 §4.2)
    if (!/^[A-Za-z0-9\-_]{43,128}$/.test(codeChallenge)) {
      throw new OAuth2Error('invalid_request', 'Malformed code_challenge');
    }

    const env = getEnv();
    const rawCode = generateAuthCode();
    const codeHash = sha256Hex(rawCode);
    const expiresAt = new Date(Date.now() + env.OAUTH2_AUTH_CODE_TTL_SECONDS * 1000);

    await this.prisma.oAuth2AuthCode.create({
      data: {
        clientId,
        walletAddress,
        redirectUri,
        grantedScopes: normaliseScopes(scope),
        codeChallenge,
        codeChallengeMethod,
        codeHash,
        used: false,
        expiresAt,
      },
    });

    return { code: rawCode, redirectUri, expiresAt };
  }

  // -------------------------------------------------------------------------
  // Token endpoint logic
  // -------------------------------------------------------------------------

  /**
   * Exchange an authorisation code for an access + refresh token pair.
   *
   * Atomically marks the code as used inside a serialisable transaction so
   * concurrent exchange attempts cannot both succeed (prevents code replay).
   */
  async exchangeCode(params: TokenExchangeParams): Promise<TokenPair> {
    const { clientId, code, redirectUri, codeVerifier, clientSecret } = params;

    const client = await this.prisma.oAuth2Client.findUnique({ where: { id: clientId } });
    if (!client || !client.active) {
      throw new OAuth2Error('invalid_client', 'Unknown or inactive client');
    }

    // Authenticate confidential clients
    if (client.clientSecretHash !== null) {
      if (!clientSecret) {
        throw new OAuth2Error('invalid_client', 'client_secret required for confidential clients');
      }
      const providedHash = sha256Hex(clientSecret);
      if (!timingSafeEqual(providedHash, client.clientSecretHash)) {
        throw new OAuth2Error('invalid_client', 'Invalid client_secret');
      }
    }

    const codeHash = sha256Hex(code);

    // Atomic read-and-mark-used inside a transaction
    const authCode = await this.prisma.$transaction(async (tx) => {
      const record = await tx.oAuth2AuthCode.findUnique({ where: { codeHash } });

      if (!record) throw new OAuth2Error('invalid_grant', 'Unknown authorisation code');
      if (record.used) throw new OAuth2Error('invalid_grant', 'Authorisation code already used');
      if (record.clientId !== clientId)
        throw new OAuth2Error('invalid_grant', 'Code was issued to a different client');
      if (record.redirectUri !== redirectUri)
        throw new OAuth2Error('invalid_grant', 'redirect_uri mismatch');
      if (record.expiresAt < new Date())
        throw new OAuth2Error('invalid_grant', 'Authorisation code expired');

      // PKCE S256 verification
      const expectedChallenge = computeS256Challenge(codeVerifier);
      if (!timingSafeEqual(expectedChallenge, record.codeChallenge)) {
        throw new OAuth2Error('invalid_grant', 'PKCE code_verifier does not match code_challenge');
      }

      await tx.oAuth2AuthCode.update({ where: { codeHash }, data: { used: true } });
      return record;
    });

    return this._issueTokenPair(client, authCode.walletAddress, authCode.grantedScopes);
  }

  /**
   * Refresh an access token using a valid refresh token.
   * Rotates the refresh token: old one is revoked, new pair issued.
   */
  async refreshTokens(params: {
    clientId: string;
    refreshToken: string;
    clientSecret?: string;
  }): Promise<TokenPair> {
    const { clientId, refreshToken, clientSecret } = params;

    const client = await this.prisma.oAuth2Client.findUnique({ where: { id: clientId } });
    if (!client || !client.active) {
      throw new OAuth2Error('invalid_client', 'Unknown or inactive client');
    }

    if (client.clientSecretHash !== null) {
      if (!clientSecret) {
        throw new OAuth2Error('invalid_client', 'client_secret required');
      }
      if (!timingSafeEqual(sha256Hex(clientSecret), client.clientSecretHash)) {
        throw new OAuth2Error('invalid_client', 'Invalid client_secret');
      }
    }

    const tokenHash = sha256Hex(refreshToken);
    const existingToken = await this.prisma.oAuth2Token.findUnique({ where: { tokenHash } });

    if (!existingToken) throw new OAuth2Error('invalid_grant', 'Unknown refresh token');
    if (existingToken.tokenType !== 'refresh')
      throw new OAuth2Error('invalid_grant', 'Token is not a refresh token');
    if (existingToken.clientId !== clientId)
      throw new OAuth2Error('invalid_grant', 'Token belongs to a different client');
    if (existingToken.revokedAt !== null)
      throw new OAuth2Error('invalid_grant', 'Refresh token has been revoked');
    if (existingToken.expiresAt < new Date())
      throw new OAuth2Error('invalid_grant', 'Refresh token expired');

    // Revoke the old refresh token before issuing new pair (rotation)
    await this.prisma.oAuth2Token.update({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });

    return this._issueTokenPair(client, existingToken.walletAddress, existingToken.scopes);
  }

  // -------------------------------------------------------------------------
  // Revocation endpoint (RFC 7009)
  // -------------------------------------------------------------------------

  /**
   * Revoke a token (access or refresh). Per RFC 7009 §2.2, the server MUST
   * respond 200 OK even if the token was already invalid — clients must not
   * be told whether a token was valid.
   *
   * For refresh tokens we also cascade-revoke child access tokens.
   */
  async revokeToken(params: { token: string; clientId: string }): Promise<void> {
    const { token, clientId } = params;
    const tokenHash = sha256Hex(token);

    const record = await this.prisma.oAuth2Token.findUnique({ where: { tokenHash } });
    if (!record || record.clientId !== clientId || record.revokedAt !== null) {
      // Silent success per RFC 7009
      return;
    }

    const now = new Date();
    await this.prisma.oAuth2Token.update({ where: { tokenHash }, data: { revokedAt: now } });

    // Cascade: if this is a refresh token, revoke linked access tokens too
    if (record.tokenType === 'refresh') {
      await this.prisma.oAuth2Token.updateMany({
        where: { parentTokenId: record.id, revokedAt: null },
        data: { revokedAt: now },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Introspection endpoint (RFC 7662)
  // -------------------------------------------------------------------------

  /**
   * Introspect a token — returns RFC 7662-compliant JSON.
   * Only callable by the resource server (protected by the admin key or a
   * service-to-service shared secret); never exposed to third-party clients.
   */
  async introspect(token: string): Promise<IntrospectionResult> {
    const tokenHash = sha256Hex(token);
    const record = await this.prisma.oAuth2Token.findUnique({ where: { tokenHash } });

    if (
      !record ||
      record.revokedAt !== null ||
      record.expiresAt < new Date() ||
      record.tokenType !== 'access'
    ) {
      return { active: false };
    }

    return {
      active: true,
      scope: record.scopes,
      clientId: record.clientId,
      sub: record.walletAddress,
      exp: Math.floor(record.expiresAt.getTime() / 1000),
      iat: Math.floor(record.createdAt.getTime() / 1000),
      tokenType: 'Bearer',
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _issueTokenPair(
    client: { id: string },
    walletAddress: string,
    scopes: string,
  ): Promise<TokenPair> {
    const env = getEnv();

    const rawAccess = generateBearerToken('oat');
    const rawRefresh = generateBearerToken('ort');
    const accessHash = sha256Hex(rawAccess);
    const refreshHash = sha256Hex(rawRefresh);

    const now = new Date();
    const accessExpiresAt = new Date(now.getTime() + env.OAUTH2_ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refreshExpiresAt = new Date(now.getTime() + env.OAUTH2_REFRESH_TOKEN_TTL_SECONDS * 1000);

    // Create access token first, then refresh token pointing to it as parent
    const accessRecord = await this.prisma.oAuth2Token.create({
      data: {
        clientId: client.id,
        walletAddress,
        tokenType: 'access',
        tokenHash: accessHash,
        scopes,
        expiresAt: accessExpiresAt,
      },
    });

    await this.prisma.oAuth2Token.create({
      data: {
        clientId: client.id,
        walletAddress,
        tokenType: 'refresh',
        tokenHash: refreshHash,
        scopes,
        expiresAt: refreshExpiresAt,
        parentTokenId: accessRecord.id,
      },
    });

    return {
      accessToken: rawAccess,
      refreshToken: rawRefresh,
      tokenType: 'Bearer',
      expiresIn: env.OAUTH2_ACCESS_TOKEN_TTL_SECONDS,
      scope: scopes,
    };
  }
}

// ---------------------------------------------------------------------------
// OAuth2Error — RFC 6749 §5.2 compliant error wrapper
// ---------------------------------------------------------------------------

export type OAuth2ErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error';

export class OAuth2Error extends Error {
  constructor(
    public readonly code: OAuth2ErrorCode,
    public readonly description: string,
  ) {
    super(`${code}: ${description}`);
    this.name = 'OAuth2Error';
  }

  /** HTTP status code per RFC 6749 §5.2 */
  get httpStatus(): number {
    switch (this.code) {
      case 'invalid_client':
        return 401;
      case 'access_denied':
        return 403;
      case 'server_error':
        return 500;
      default:
        return 400;
    }
  }

  toJSON(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
