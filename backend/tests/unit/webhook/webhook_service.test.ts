import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WebhookService,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type WebhookEventType,
} from '../../../src/webhook/webhook_service.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockFetch() {
  return vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
}

function createSilentDeliveryCallback() {
  return vi.fn();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebhookService', () => {
  let onDelivery: ReturnType<typeof createSilentDeliveryCallback>;
  let service: WebhookService;

  beforeEach(() => {
    onDelivery = createSilentDeliveryCallback();
    service = new WebhookService(onDelivery, {
      deliveryTimeoutMs: 1000,
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
    });
    vi.clearAllMocks();
  });

  // ── Subscription management ─────────────────────────────────────────────

  describe('register', () => {
    it('registers a new subscription with a generated secret', () => {
      const sub = service.register('https://example.com/webhook', [
        'billing.cycle.settled',
        'refund.completed',
      ]);

      expect(sub.id).toMatch(/^whsub_/);
      expect(sub.url).toBe('https://example.com/webhook');
      expect(sub.eventTypes).toEqual(['billing.cycle.settled', 'refund.completed']);
      expect(sub.secret).toBeTruthy();
      expect(sub.secret.length).toBe(64); // 2 × UUID without dashes
      expect(sub.enabled).toBe(true);
    });

    it('uses provided secret when specified', () => {
      const sub = service.register(
        'https://example.com/webhook',
        ['device.registered'],
        'my-custom-secret',
      );

      expect(sub.secret).toBe('my-custom-secret');
    });

    it('creates subscriptions with unique IDs', () => {
      const sub1 = service.register('https://a.com/hook', ['device.registered']);
      const sub2 = service.register('https://b.com/hook', ['device.disabled']);

      expect(sub1.id).not.toBe(sub2.id);
    });
  });

  describe('update', () => {
    it('updates subscription fields', () => {
      const sub = service.register('https://old.example.com/hook', ['device.registered']);

      const updated = service.update(sub.id, {
        url: 'https://new.example.com/hook',
        enabled: false,
      });

      expect(updated).not.toBeNull();
      expect(updated!.url).toBe('https://new.example.com/hook');
      expect(updated!.enabled).toBe(false);
    });

    it('returns null for unknown subscription', () => {
      const result = service.update('nonexistent', { enabled: false });
      expect(result).toBeNull();
    });

    it('can update event types', () => {
      const sub = service.register('https://example.com/hook', ['device.registered']);

      const updated = service.update(sub.id, {
        eventTypes: ['billing.cycle.settled', 'refund.completed'],
      });

      expect(updated!.eventTypes).toEqual(['billing.cycle.settled', 'refund.completed']);
    });
  });

  describe('deregister', () => {
    it('removes a subscription', () => {
      const sub = service.register('https://example.com/hook', ['device.registered']);

      const removed = service.deregister(sub.id);
      expect(removed).toBe(true);
      expect(service.getSubscription(sub.id)).toBeUndefined();
    });

    it('returns false for unknown subscription', () => {
      expect(service.deregister('unknown')).toBe(false);
    });
  });

  describe('listSubscriptions', () => {
    it('lists all subscriptions', () => {
      service.register('https://a.com/hook', ['device.registered']);
      service.register('https://b.com/hook', ['billing.cycle.settled']);

      const all = service.listSubscriptions();
      expect(all).toHaveLength(2);
    });

    it('filters by event type', () => {
      const matching = service.register('https://matching.com/hook', [
        'billing.cycle.settled',
        'refund.completed',
      ]);
      service.register('https://other.com/hook', ['device.registered']);

      const filtered = service.listSubscriptions('billing.cycle.settled');
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.id).toBe(matching.id);
    });

    it('excludes disabled subscriptions from filtered list', () => {
      const sub = service.register('https://disabled.com/hook', ['billing.cycle.settled']);
      service.update(sub.id, { enabled: false });

      const filtered = service.listSubscriptions('billing.cycle.settled');
      expect(filtered).toHaveLength(0);
    });
  });

  // ── Delivery ────────────────────────────────────────────────────────────

  describe('publish', () => {
    it('delivers to matching subscriptions', async () => {
      const mockFetch = createMockFetch();
      const svc = new WebhookService(onDelivery, {
        fetchImpl: mockFetch as unknown as typeof fetch,
        deliveryTimeoutMs: 1000,
        maxAttempts: 1,
      });

      svc.register('https://example.com/hook', ['billing.cycle.settled']);

      const results = await svc.publish('billing.cycle.settled', {
        cycleId: 'cycle-123',
        amount: '1000',
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.acknowledged).toBe(true);
      expect(results[0]!.statusCode).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('includes correct headers in the delivery', async () => {
      const mockFetch = createMockFetch();
      const svc = new WebhookService(onDelivery, {
        fetchImpl: mockFetch as unknown as typeof fetch,
        deliveryTimeoutMs: 1000,
        maxAttempts: 1,
      });

      const sub = svc.register('https://example.com/hook', ['refund.completed']);

      await svc.publish('refund.completed', { refundId: 'ref-1' });

      const fetchCall = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = fetchCall[1].headers as Record<string, string>;

      expect(headers['Content-Type']).toBe('application/json');
      expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBeTruthy();
      expect(headers[WEBHOOK_DELIVERY_ID_HEADER]).toMatch(/^whdel_/);
      expect(headers[WEBHOOK_TIMESTAMP_HEADER]).toBeTruthy();
    });

    it('signs payload with the subscription secret', async () => {
      const mockFetch = createMockFetch();
      const svc = new WebhookService(onDelivery, {
        fetchImpl: mockFetch as unknown as typeof fetch,
        deliveryTimeoutMs: 1000,
        maxAttempts: 1,
      });

      const sub = svc.register('https://example.com/hook', ['device.registered'], 'test-secret');

      await svc.publish('device.registered', { deviceId: 'dev-1' });

      // Extract the body and signature
      const fetchCall = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = fetchCall[1].body as string;
      const signature = (fetchCall[1].headers as Record<string, string>)[
        WEBHOOK_SIGNATURE_HEADER
      ];

      // Verify the signature
      const verification = WebhookService.verifySignature(body, signature!, 'test-secret');
      expect(verification.valid).toBe(true);
    });

    it('retries on failure', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const svc = new WebhookService(onDelivery, {
        fetchImpl: mockFetch as unknown as typeof fetch,
        deliveryTimeoutMs: 500,
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 50,
      });

      svc.register('https://example.com/hook', ['device.registered']);

      const results = await svc.publish('device.registered', { deviceId: 'dev-1' });

      expect(results[0]!.acknowledged).toBe(true);
      expect(results[0]!.attemptCount).toBe(3);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('gives up after maxAttempts', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('persistent failure'));

      const svc = new WebhookService(onDelivery, {
        fetchImpl: mockFetch as unknown as typeof fetch,
        deliveryTimeoutMs: 500,
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 50,
      });

      svc.register('https://example.com/hook', ['device.registered']);

      const results = await svc.publish('device.registered', { deviceId: 'dev-1' });

      expect(results[0]!.acknowledged).toBe(false);
      expect(results[0]!.attemptCount).toBe(3);
      expect(results[0]!.error).toContain('persistent failure');
    });

    it('does not retry on 4xx errors', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 400, statusText: 'Bad Request' }));

      const svc = new WebhookService(onDelivery, {
        fetchImpl: mockFetch as unknown as typeof fetch,
        deliveryTimeoutMs: 500,
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 50,
      });

      svc.register('https://example.com/hook', ['device.registered']);

      const results = await svc.publish('device.registered', { deviceId: 'dev-1' });

      expect(results[0]!.acknowledged).toBe(false);
      expect(results[0]!.attemptCount).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns empty results when no subscriptions match', async () => {
      service.register('https://example.com/hook', ['device.registered']);

      const results = await service.publish('billing.cycle.settled' as WebhookEventType, {
        id: '1',
      });

      expect(results).toHaveLength(0);
    });

    it('calls onDelivery callback for each attempt', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('fail-1'))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const svc = new WebhookService(onDelivery, {
        fetchImpl: mockFetch as unknown as typeof fetch,
        deliveryTimeoutMs: 500,
        maxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 50,
      });

      svc.register('https://example.com/hook', ['device.registered']);

      await svc.publish('device.registered', { deviceId: 'dev-1' });

      // Should be called twice: once for the failed attempt, once for the success
      expect(onDelivery).toHaveBeenCalledTimes(2);

      const lastCall = onDelivery.mock.calls[1]![0]!;
      expect(lastCall.acknowledged).toBe(true);
      expect(lastCall.attemptCount).toBe(2);
    });

    it('delivers to multiple subscriptions independently', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

      const svc = new WebhookService(onDelivery, {
        fetchImpl: mockFetch as unknown as typeof fetch,
        deliveryTimeoutMs: 500,
        maxAttempts: 1,
      });

      svc.register('https://a.com/hook', ['billing.cycle.settled']);
      svc.register('https://b.com/hook', ['billing.cycle.settled']);

      const results = await svc.publish('billing.cycle.settled', { cycleId: 'c-1' });

      expect(results).toHaveLength(2);
      expect(results.every((r: { acknowledged: boolean }) => r.acknowledged)).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ── Signature verification ──────────────────────────────────────────────

  describe('verifySignature', () => {
    it('verifies a valid signature', () => {
      const payload = JSON.stringify({ event: 'test', data: { id: '1' } });
      const secret = 'my-secret';
      const signature = WebhookService.computeSignature(payload, secret);

      const result = WebhookService.verifySignature(payload, signature, secret);
      expect(result.valid).toBe(true);
    });

    it('rejects an invalid signature', () => {
      const payload = JSON.stringify({ event: 'test' });
      const secret = 'my-secret';
      const wrongSignature = '00'.repeat(32);

      const result = WebhookService.verifySignature(payload, wrongSignature, secret);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Signature mismatch');
    });

    it('rejects payload with a different secret', () => {
      const payload = JSON.stringify({ event: 'test' });
      const signature = WebhookService.computeSignature(payload, 'secret-a');

      const result = WebhookService.verifySignature(payload, signature, 'secret-b');
      expect(result.valid).toBe(false);
    });

    it('validates timestamp freshness', () => {
      const payload = JSON.stringify({ event: 'test' });
      const secret = 'my-secret';
      const signature = WebhookService.computeSignature(payload, secret);

      // Recent timestamp
      const recentTimestamp = String(Date.now() - 1000);
      const recentResult = WebhookService.verifySignature(
        payload,
        signature,
        secret,
        recentTimestamp,
        60_000,
      );
      expect(recentResult.valid).toBe(true);

      // Old timestamp
      const oldTimestamp = String(Date.now() - 600_000); // 10 min old
      const oldResult = WebhookService.verifySignature(
        payload,
        signature,
        secret,
        oldTimestamp,
        60_000,
      );
      expect(oldResult.valid).toBe(false);
      expect(oldResult.reason).toContain('Timestamp too old');
    });

    it('rejects invalid timestamp values', () => {
      const result = WebhookService.verifySignature(
        '{}',
        'somesig',
        'secret',
        'not-a-number',
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid timestamp');
    });
  });

  describe('computeSignature', () => {
    it('computes a valid HMAC-SHA256 signature', () => {
      const sig = WebhookService.computeSignature('hello', 'world');
      expect(sig).toHaveLength(64); // SHA-256 hex is 64 chars
      expect(/^[a-f0-9]{64}$/.test(sig)).toBe(true);
    });

    it('produces deterministic signatures', () => {
      const sig1 = WebhookService.computeSignature('same payload', 'same secret');
      const sig2 = WebhookService.computeSignature('same payload', 'same secret');
      expect(sig1).toBe(sig2);
    });

    it('produces different signatures for different payloads', () => {
      const sig1 = WebhookService.computeSignature('payload-a', 'secret');
      const sig2 = WebhookService.computeSignature('payload-b', 'secret');
      expect(sig1).not.toBe(sig2);
    });
  });
});
