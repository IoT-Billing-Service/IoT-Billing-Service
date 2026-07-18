import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PagerDutyClient } from '../../../src/incident_response/pagerduty_client.js';
import type { PagerDutyConfig } from '../../../src/incident_response/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClient(config: Partial<PagerDutyConfig> = {}): PagerDutyClient {
  return new PagerDutyClient({
    routingKey: 'test-routing-key',
    apiBaseUrl: 'http://localhost:9999',
    timeoutMs: 1000,
    maxRetries: 2,
    retryBaseDelayMs: 10,
    ...config,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PagerDutyClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('trigger', () => {
    it('should successfully trigger an incident', async () => {
      const mockResponse = {
        status: 'success',
        dedup_key: 'test-dedup-key',
        message: 'Event processed',
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: () => Promise.resolve(mockResponse),
      });

      const client = createClient();
      const result = await client.trigger(
        'Test incident',
        'critical',
        'dedup-123',
        { test: true },
      );

      expect(result.status).toBe('success');
      expect(result.dedup_key).toBe('test-dedup-key');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('should handle API errors', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({
          status: 'failure',
          dedup_key: 'dedup-123',
          message: 'Invalid routing key',
          errors: ['routing_key is invalid'],
        }),
      });

      const client = createClient();
      const result = await client.trigger('Test', 'error', 'dedup-123');

      expect(result.status).toBe('failure');
      expect(result.errors).toBeDefined();
    });

    it('should retry on 5xx errors', async () => {
      const mockSuccess = {
        status: 'success',
        dedup_key: 'dedup-123',
        message: 'Event processed',
      };

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ status: 'failure', dedup_key: 'dedup-123', message: 'Server error' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 202,
          json: () => Promise.resolve(mockSuccess),
        });

      globalThis.fetch = fetchMock;

      const client = createClient({ maxRetries: 2, retryBaseDelayMs: 10 });
      const result = await client.trigger('Test', 'error', 'dedup-123');

      expect(result.status).toBe('success');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should handle network timeouts', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

      const client = createClient({ maxRetries: 1, retryBaseDelayMs: 10 });
      const result = await client.trigger('Test', 'error', 'dedup-123');

      expect(result.status).toBe('failure');
      expect(result.message).toBeDefined();
    });
  });

  describe('acknowledge', () => {
    it('should successfully acknowledge an incident', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: () => Promise.resolve({
          status: 'success',
          dedup_key: 'dedup-123',
          message: 'Event acknowledged',
        }),
      });

      const client = createClient();
      const result = await client.acknowledge('dedup-123');

      expect(result.status).toBe('success');
    });
  });

  describe('resolve', () => {
    it('should successfully resolve an incident', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: () => Promise.resolve({
          status: 'success',
          dedup_key: 'dedup-123',
          message: 'Event resolved',
        }),
      });

      const client = createClient();
      const result = await client.resolve('dedup-123');

      expect(result.status).toBe('success');
    });
  });
});