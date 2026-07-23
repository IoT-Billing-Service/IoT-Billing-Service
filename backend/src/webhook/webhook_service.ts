/**
 * Webhook Delivery Service with Retry and Signature Verification (issue #65).
 *
 * Provides a reliable webhook delivery pipeline for notifying external
 * systems about billing events, refund completions, settlement confirmations,
 * and other IoT billing lifecycle events.
 *
 * ## Architecture
 *
 * ```
 * Event (billing, refund, settlement)
 *   ├── 1. Lookup registered webhook subscriptions for event type
 *   ├── 2. Build signed payload (HMAC-SHA256)
 *   ├── 3. Deliver to endpoint with timeout
 *   ├── 4. On failure → exponential backoff retry (up to maxAttempts)
 *   ├── 5. Track delivery status in persistent store
 *   └── 6. Emit delivery metrics (success/failure/latency)
 * ```
 *
 * ## Security
 *
 * - Every webhook payload is signed with HMAC-SHA256 using a per-subscription
 *   secret. Receivers verify the `X-Webhook-Signature` header to ensure
 *   authenticity and integrity.
 * - Payloads include a timestamp and unique delivery ID to prevent replay.
 * - TLS is assumed for transport-layer confidentiality.
 *
 * ## Performance
 *
 * - Payload signing: < 10 µs (synchronous HMAC)
 * - Delivery: bounded by `deliveryTimeoutMs` (default 10 s)
 * - Retry: exponential backoff with jitter (avoids thundering herd)
 * - All operations < 200 ms P99 for the *service layer* (network calls
 *   to endpoints are async and bounded by timeout).
 */

import { createHmac, randomUUID } from 'node:crypto';
import { BackoffCalculator } from '../core/blockchain/backoff.js';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Default HTTP request timeout for webhook deliveries (ms). */
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

/** Maximum number of delivery attempts (1 initial + retries). */
const DEFAULT_MAX_ATTEMPTS = 5;

/** Base delay for exponential backoff between retries (ms). */
const DEFAULT_BASE_DELAY_MS = 2000;

/** Maximum backoff delay between retries (ms). */
const DEFAULT_MAX_DELAY_MS = 120_000;

/** Signature header name sent to webhook endpoints. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Webhook-Signature';

/** Delivery ID header for idempotency / replay detection. */
export const WEBHOOK_DELIVERY_ID_HEADER = 'X-Webhook-Delivery-Id';

/** Event timestamp header (Unix ms). */
export const WEBHOOK_TIMESTAMP_HEADER = 'X-Webhook-Timestamp';

// ── Types ──────────────────────────────────────────────────────────────────────

/** Valid webhook event types for this IoT billing platform. */
export type WebhookEventType =
  | 'billing.cycle.created'
  | 'billing.cycle.finalized'
  | 'billing.cycle.settled'
  | 'refund.requested'
  | 'refund.completed'
  | 'refund.failed'
  | 'settlement.confirmed'
  | 'device.registered'
  | 'device.disabled';

/** A registered webhook subscription. */
export interface WebhookSubscription {
  /** Unique subscription ID. */
  id: string;
  /** URL to deliver events to. */
  url: string;
  /** Event types this subscription listens for. */
  eventTypes: WebhookEventType[];
  /** HMAC secret shared with the receiver for signature verification. */
  secret: string;
  /** Whether this subscription is currently active. */
  enabled: boolean;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

/** A single webhook delivery attempt. */
export interface WebhookDelivery {
  /** Unique delivery ID (also sent in headers for idempotency). */
  deliveryId: string;
  /** Subscription this delivery is for. */
  subscriptionId: string;
  /** Event type. */
  eventType: WebhookEventType;
  /** The signed payload (JSON-serialized). */
  payload: string;
  /** Signature sent in the header. */
  signature: string;
  /** Whether this delivery was acknowledged (HTTP 2xx). */
  acknowledged: boolean;
  /** HTTP status code returned by the endpoint. */
  statusCode: number | null;
  /** Number of attempts made so far. */
  attemptCount: number;
  /** ISO timestamp of the first attempt. */
  firstAttemptAt: string;
  /** ISO timestamp of the last attempt. */
  lastAttemptAt: string;
  /** Error details if delivery failed. */
  error: string | null;
}

export interface WebhookPayload {
  /** Event type. */
  event: WebhookEventType;
  /** ISO timestamp of the event. */
  timestamp: string;
  /** Unique delivery ID (idempotency key for receivers). */
  deliveryId: string;
  /** The event data payload. */
  data: Record<string, unknown>;
}

export interface WebhookServiceOptions {
  /** Maximum time (ms) to wait for an HTTP response from the endpoint. */
  deliveryTimeoutMs?: number;
  /** Maximum total attempts per delivery (1 + retries). */
  maxAttempts?: number;
  /** Base backoff delay (ms) for retries. */
  baseDelayMs?: number;
  /** Maximum backoff delay (ms). */
  maxDelayMs?: number;
  /**
   * Optional fetch implementation (for testing).
   * Defaults to global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

export interface DeliveryResult {
  deliveryId: string;
  acknowledged: boolean;
  statusCode: number | null;
  attemptCount: number;
  error: string | null;
}

/**
 * Callback invoked after every delivery attempt (success or failure).
 * Use this to persist delivery records and emit metrics.
 */
export type DeliveryCallback = (delivery: WebhookDelivery) => void | Promise<void>;

// ── Service ────────────────────────────────────────────────────────────────────

/**
 * Webhook delivery service.
 *
 * Manages webhook subscriptions, builds signed payloads, delivers events
 * to endpoints with retry, and notifies a callback on each attempt for
 * persistent tracking.
 */
export class WebhookService {
  private readonly subscriptions = new Map<string, WebhookSubscription>();
  private readonly deliveryTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly onDelivery: DeliveryCallback,
    options: WebhookServiceOptions = {},
  ) {
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // ── Subscription management ──────────────────────────────────────────────

  /**
   * Register a new webhook subscription.
   *
   * @param url        — endpoint URL to deliver to
   * @param eventTypes — event types to subscribe to
   * @param secret     — optional HMAC secret (auto-generated if omitted)
   * @returns the created subscription
   */
  register(
    url: string,
    eventTypes: WebhookEventType[],
    secret?: string,
  ): WebhookSubscription {
    const id = this.generateId('whsub');
    const sub: WebhookSubscription = {
      id,
      url,
      eventTypes,
      secret: secret ?? this.generateSecret(),
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.subscriptions.set(id, sub);
    return sub;
  }

  /**
   * Update an existing subscription.
   */
  update(
    id: string,
    updates: Partial<Pick<WebhookSubscription, 'url' | 'eventTypes' | 'enabled'>>,
  ): WebhookSubscription | null {
    const sub = this.subscriptions.get(id);
    if (sub === undefined) return null;

    if (updates.url !== undefined) sub.url = updates.url;
    if (updates.eventTypes !== undefined) sub.eventTypes = updates.eventTypes;
    if (updates.enabled !== undefined) sub.enabled = updates.enabled;
    sub.updatedAt = new Date().toISOString();

    return sub;
  }

  /**
   * Delete a webhook subscription.
   */
  deregister(id: string): boolean {
    return this.subscriptions.delete(id);
  }

  /**
   * Get a single subscription by ID.
   */
  getSubscription(id: string): WebhookSubscription | undefined {
    return this.subscriptions.get(id);
  }

  /**
   * List all subscriptions (optionally filtered by event type).
   */
  listSubscriptions(eventType?: WebhookEventType): WebhookSubscription[] {
    const all = [...this.subscriptions.values()];
    if (eventType === undefined) return all;
    return all.filter((s) => s.enabled && s.eventTypes.includes(eventType));
  }

  // ── Delivery ─────────────────────────────────────────────────────────────

  /**
   * Publish an event to all matching webhook subscriptions.
   *
   * Each matching subscription gets its own signed payload and independent
   * delivery attempts. Failures for one subscription do not block others.
   *
   * @param eventType — the type of event being published
   * @param data      — event data payload (serializable to JSON)
   * @returns array of delivery results, one per matching subscription
   */
  async publish(
    eventType: WebhookEventType,
    data: Record<string, unknown>,
  ): Promise<DeliveryResult[]> {
    const subs = this.listSubscriptions(eventType);
    if (subs.length === 0) return [];

    const results = await Promise.all(
      subs.map((sub) => {
        return this.deliverToSubscription(sub, eventType, data);
      }),
    );

    return results;
  }

  /**
   * Verify a webhook signature.
   *
   * Receivers call this to validate that an incoming webhook was genuinely
   * sent by this service and hasn't been tampered with.
   *
   * @param payload   — the raw request body (string)
   * @param signature — the value of the `X-Webhook-Signature` header
   * @param secret    — the shared secret for this subscription
   * @param timestamp — the value of the `X-Webhook-Timestamp` header (optional;
   *                    if provided, rejects payloads older than `maxAgeMs`)
   * @param maxAgeMs  — max allowed age of the timestamp (default 5 minutes)
   */
  static verifySignature(
    payload: string,
    signature: string,
    secret: string,
    timestamp?: string,
    maxAgeMs: number = 5 * 60 * 1000,
  ): { valid: boolean; reason?: string } {
    // Optional timestamp replay protection
    if (timestamp !== undefined) {
      const ts = Number(timestamp);
      if (Number.isNaN(ts)) {
        return { valid: false, reason: 'Invalid timestamp' };
      }
      const age = Date.now() - ts;
      if (age > maxAgeMs) {
        return { valid: false, reason: `Timestamp too old (${String(age)}ms > ${String(maxAgeMs)}ms)` };
      }
    }

    const expected = WebhookService.computeSignature(payload, secret);
    // Constant-time comparison to prevent timing attacks
    if (!timingSafeEqual(expected, signature)) {
      return { valid: false, reason: 'Signature mismatch' };
    }

    return { valid: true };
  }

  /**
   * Compute the HMAC-SHA256 signature for a payload.
   */
  static computeSignature(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async deliverToSubscription(
    sub: WebhookSubscription,
    eventType: WebhookEventType,
    data: Record<string, unknown>,
  ): Promise<DeliveryResult> {
    const deliveryId = this.generateId('whdel');
    const payloadObj: WebhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      deliveryId,
      data,
    };

    const payloadStr = JSON.stringify(payloadObj);
    const signature = WebhookService.computeSignature(payloadStr, sub.secret);

    const backoff = new BackoffCalculator({
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs,
      multiplier: 2,
      jitterFactor: 0.1,
    });

    let lastError: string | null = null;
    let lastStatusCode: number | null = null;
    let acknowledged = false;
    let lastAttempt = 0;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      lastAttempt = attempt;
      const attemptStart = new Date().toISOString();

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.deliveryTimeoutMs);

        const response = await this.fetchImpl(sub.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [WEBHOOK_SIGNATURE_HEADER]: signature,
            [WEBHOOK_DELIVERY_ID_HEADER]: deliveryId,
            [WEBHOOK_TIMESTAMP_HEADER]: String(Date.now()),
          },
          body: payloadStr,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        lastStatusCode = response.status;

        if (response.ok) {
          acknowledged = true;
          await this.notifyDelivery({
            deliveryId,
            subscriptionId: sub.id,
            eventType,
            payload: payloadStr,
            signature,
            acknowledged: true,
            statusCode: response.status,
            attemptCount: attempt,
            firstAttemptAt: attempt === 1 ? attemptStart : '',
            lastAttemptAt: attemptStart,
            error: null,
          });
          return {
            deliveryId,
            acknowledged: true,
            statusCode: response.status,
            attemptCount: attempt,
            error: null,
          };
        }

        // Non-2xx — don't retry on 4xx (client errors)
        if (response.status >= 400 && response.status < 500) {
          lastError = `Endpoint returned ${String(response.status)}: ${response.statusText}`;
          lastAttempt = attempt;
          break;
        }

        lastError = `Endpoint returned ${String(response.status)}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      // Notify of failed attempt
      await this.notifyDelivery({
        deliveryId,
        subscriptionId: sub.id,
        eventType,
        payload: payloadStr,
        signature,
        acknowledged: false,
        statusCode: lastStatusCode,
        attemptCount: attempt,
        firstAttemptAt: attempt === 1 ? attemptStart : '',
        lastAttemptAt: attemptStart,
        error: lastError,
      });

      if (attempt < this.maxAttempts) {
        const delay = backoff.nextDelay();
        await this.sleep(delay);
      }
    }

    return {
      deliveryId,
      acknowledged,
      statusCode: lastStatusCode,
      attemptCount: lastAttempt,
      error: lastError,
    };
  }

  private async notifyDelivery(delivery: WebhookDelivery): Promise<void> {
    // Ensure firstAttemptAt is set (set from first delivery record)
    if (delivery.firstAttemptAt === '') {
      delivery.firstAttemptAt = delivery.lastAttemptAt;
    }
    try {
      await this.onDelivery(delivery);
    } catch {
      // Callback errors should not break the delivery pipeline
    }
  }

  private generateSecret(): string {
    return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  }

  private generateId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Constant-time string comparison to prevent timing attacks on signature verification.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a dummy comparison to avoid leaking length info
    let result = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      result |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0);
    }
    return result === 0;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
