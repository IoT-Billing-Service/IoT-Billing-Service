import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackClient } from '../../../src/incident_response/slack_client.js';
import type { DetectedIncident, SlackConfig } from '../../../src/incident_response/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClient(config: Partial<SlackConfig> = {}): SlackClient {
  return new SlackClient({
    webhookUrl: 'http://localhost:9999/services/T00/B00/xxx',
    timeoutMs: 1000,
    maxRetries: 2,
    retryBaseDelayMs: 10,
    ...config,
  });
}

function createTestIncident(overrides: Partial<DetectedIncident> = {}): DetectedIncident {
  return {
    id: 'test-incident-1',
    title: 'Test incident',
    description: 'A test incident for unit testing',
    severity: 'critical',
    source: 'billing_anomaly',
    detectionRule: 'billing_anomaly_double_finalization',
    detectedAt: new Date().toISOString(),
    dedupKey: 'test-dedup-key',
    context: { key: 'value' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('notifyTriggered', () => {
    it('should post a formatted message for a triggered incident', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('ok') });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.notifyTriggered(createTestIncident(), 'billing_anomaly_response');

      expect(result.status).toBe('success');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:9999/services/T00/B00/xxx');
      const body = JSON.parse(options.body);
      expect(body.text).toContain('Test incident');
      expect(body.attachments[0].fields).toContainEqual({ title: 'Severity', value: 'critical', short: true });
      expect(body.attachments[0].fields).toContainEqual({
        title: 'Runbook',
        value: 'billing_anomaly_response',
        short: true,
      });
    });

    it('should include the configured channel when set', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('ok') });
      globalThis.fetch = fetchMock;

      const client = createClient({ channel: '#billing-alerts' });
      await client.notifyTriggered(createTestIncident());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.channel).toBe('#billing-alerts');
    });

    it('should omit the channel field entirely when not configured', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('ok') });
      globalThis.fetch = fetchMock;

      const client = createClient();
      await client.notifyTriggered(createTestIncident());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.channel).toBeUndefined();
    });

    it('should retry on 5xx errors', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('unavailable') })
        .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('ok') });
      globalThis.fetch = fetchMock;

      const client = createClient({ maxRetries: 2, retryBaseDelayMs: 10 });
      const result = await client.notifyTriggered(createTestIncident());

      expect(result.status).toBe('success');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should not retry on non-retryable 4xx errors', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('invalid_payload') });
      globalThis.fetch = fetchMock;

      const client = createClient({ maxRetries: 2, retryBaseDelayMs: 10 });
      const result = await client.notifyTriggered(createTestIncident());

      expect(result.status).toBe('failure');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should handle network failures gracefully', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

      const client = createClient({ maxRetries: 1, retryBaseDelayMs: 10 });
      const result = await client.notifyTriggered(createTestIncident());

      expect(result.status).toBe('failure');
      expect(result.message).toBeDefined();
    });
  });

  describe('notifyResolved', () => {
    it('should post a success message when the runbook completed', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('ok') });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.notifyResolved(createTestIncident(), 'completed');

      expect(result.status).toBe('success');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toContain('resolved');
      expect(body.attachments[0].fields).toContainEqual({ title: 'Outcome', value: 'completed', short: true });
    });

    it('should post a failure message when the runbook failed', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('ok') });
      globalThis.fetch = fetchMock;

      const client = createClient();
      const result = await client.notifyResolved(createTestIncident(), 'failed');

      expect(result.status).toBe('success');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toContain('runbook failed');
      expect(body.attachments[0].fields).toContainEqual({ title: 'Outcome', value: 'failed', short: true });
    });
  });
});
