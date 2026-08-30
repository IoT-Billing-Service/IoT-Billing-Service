/**
 * Slack Incoming Webhook Client
 *
 * Posts incident notifications to a Slack channel via an Incoming Webhook
 * (issue #281). Runs alongside `PagerDutyClient` in `RunbookEngine` as a
 * second, independent notification channel — Slack posting failures never
 * block or fail a runbook execution, since Slack here is a notification
 * side-channel, not the incident system of record (PagerDuty already
 * fills that role; see runbook_engine.ts).
 *
 * ## API Reference
 * - Incoming Webhooks: https://api.slack.com/messaging/webhooks
 * - Block Kit: https://api.slack.com/block-kit
 */

import type { DetectedIncident, IncidentSeverity, SlackConfig } from './types.js';

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default maximum retries for failed webhook posts. */
const DEFAULT_MAX_RETRIES = 3;

/** Default retry backoff base delay in milliseconds. */
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;

/** HTTP status codes that should be retried. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** Slack's "attachment" side-bar colors, keyed by incident severity. */
const SEVERITY_COLOR: Record<IncidentSeverity, string> = {
  critical: '#d32f2f',
  error: '#f57c00',
  warning: '#fbc02d',
  info: '#1976d2',
};

export interface SlackPostResult {
  status: 'success' | 'failure';
  message: string;
}

/**
 * Client for Slack's Incoming Webhooks API.
 *
 * Provides methods to notify a channel when an incident is triggered or
 * resolved, with automatic retry and exponential backoff — matching
 * `PagerDutyClient`'s retry behavior so both channels degrade the same
 * way under Slack/PagerDuty outages or rate limiting.
 */
export class SlackClient {
  private readonly webhookUrl: string;
  private readonly channel: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(config: SlackConfig) {
    this.webhookUrl = config.webhookUrl;
    this.channel = config.channel;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  }

  /**
   * Notify Slack that an incident was triggered.
   *
   * @param incident - The detected incident.
   * @param runbookName - Name of the runbook selected to handle it.
   */
  async notifyTriggered(incident: DetectedIncident, runbookName?: string): Promise<SlackPostResult> {
    return this.post({
      text: `🚨 Incident triggered: ${incident.title}`,
      attachments: [
        {
          color: SEVERITY_COLOR[incident.severity],
          fields: [
            { title: 'Severity', value: incident.severity, short: true },
            { title: 'Source', value: incident.source, short: true },
            { title: 'Detection rule', value: incident.detectionRule, short: true },
            { title: 'Runbook', value: runbookName ?? '(none)', short: true },
            { title: 'Description', value: incident.description, short: false },
          ],
          footer: `Incident ID: ${incident.id} · Dedup key: ${incident.dedupKey}`,
          ts: Math.floor(new Date(incident.detectedAt).getTime() / 1000),
        },
      ],
    });
  }

  /**
   * Notify Slack that an incident was resolved.
   *
   * @param incident - The detected incident that was resolved.
   * @param outcome - Whether the runbook completed successfully or failed.
   */
  async notifyResolved(incident: DetectedIncident, outcome: 'completed' | 'failed'): Promise<SlackPostResult> {
    const emoji = outcome === 'completed' ? '✅' : '⚠️';
    return this.post({
      text: `${emoji} Incident ${outcome === 'completed' ? 'resolved' : 'runbook failed'}: ${incident.title}`,
      attachments: [
        {
          color: outcome === 'completed' ? '#2e7d32' : '#d32f2f',
          fields: [
            { title: 'Severity', value: incident.severity, short: true },
            { title: 'Outcome', value: outcome, short: true },
          ],
          footer: `Incident ID: ${incident.id} · Dedup key: ${incident.dedupKey}`,
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    });
  }

  /**
   * Post a raw message payload to the configured Slack webhook.
   */
  async post(payload: {
    text: string;
    attachments?: Array<{
      color: string;
      fields: Array<{ title: string; value: string; short: boolean }>;
      footer?: string;
      ts?: number;
    }>;
  }): Promise<SlackPostResult> {
    const body = {
      ...(this.channel ? { channel: this.channel } : {}),
      ...payload,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          return { status: 'success', message: 'ok' };
        }

        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < this.maxRetries) {
          lastError = new Error(`Slack webhook returned ${response.status}`);
          await this.sleep(this.getBackoffDelay(attempt));
          continue;
        }

        const responseText = await response.text().catch(() => '');
        return {
          status: 'failure',
          message: `HTTP ${response.status}${responseText ? `: ${responseText}` : ''}`,
        };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new Error(`Slack webhook request timed out after ${this.timeoutMs}ms`);
        } else {
          lastError = error instanceof Error ? error : new Error(String(error));
        }

        if (attempt < this.maxRetries) {
          await this.sleep(this.getBackoffDelay(attempt));
        }
      }
    }

    return {
      status: 'failure',
      message: lastError?.message ?? 'Max retries exceeded',
    };
  }

  private getBackoffDelay(attempt: number): number {
    const baseDelay = this.retryBaseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * this.retryBaseDelayMs;
    return Math.min(baseDelay + jitter, 30_000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
