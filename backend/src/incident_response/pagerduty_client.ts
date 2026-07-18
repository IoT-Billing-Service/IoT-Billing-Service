/**
 * PagerDuty Events API v2 Client
 *
 * Handles communication with PagerDuty's Events API for triggering,
 * acknowledging, and resolving incidents. Implements retry with
 * exponential backoff and comprehensive error handling.
 *
 * ## API Reference
 * - Events API v2: https://developer.pagerduty.com/docs/events-api-v2/overview
 * - Deduplication: https://developer.pagerduty.com/docs/events-api-v2/trigger-events
 */

import type {
  PagerDutyAction,
  PagerDutyConfig,
  PagerDutyEventPayload,
  PagerDutyEventResponse,
  IncidentSeverity,
} from './types.js';

/** Default PagerDuty Events API v2 endpoint. */
const DEFAULT_API_BASE_URL = 'https://events.pagerduty.com/v2';

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default maximum retries for failed API calls. */
const DEFAULT_MAX_RETRIES = 3;

/** Default retry backoff base delay in milliseconds. */
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;

/** HTTP status codes that should be retried. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Client for the PagerDuty Events API v2.
 *
 * Provides methods to trigger, acknowledge, and resolve incidents
 * with automatic retry and exponential backoff.
 */
export class PagerDutyClient {
  private readonly routingKey: string;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(config: PagerDutyConfig) {
    this.routingKey = config.routingKey;
    this.apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  }

  /**
   * Trigger a new PagerDuty incident.
   *
   * @param summary - Human-readable summary of the incident.
   * @param severity - Severity level.
   * @param dedupKey - Deduplication key for idempotent event submission.
   * @param details - Optional custom details payload.
   * @returns The PagerDuty API response.
   */
  async trigger(
    summary: string,
    severity: IncidentSeverity,
    dedupKey: string,
    details?: Record<string, unknown>,
  ): Promise<PagerDutyEventResponse> {
    return this.sendEvent({
      event_action: 'trigger',
      payload: {
        summary,
        severity,
        source: 'iot-billing-backend',
        dedup_key: dedupKey,
        custom_details: details,
      },
    });
  }

  /**
   * Acknowledge an existing PagerDuty incident.
   *
   * @param dedupKey - Deduplication key of the incident to acknowledge.
   * @returns The PagerDuty API response.
   */
  async acknowledge(dedupKey: string): Promise<PagerDutyEventResponse> {
    return this.sendEvent({
      event_action: 'acknowledge',
      payload: {
        summary: 'Incident acknowledged by automated runbook',
        severity: 'info',
        source: 'iot-billing-backend',
        dedup_key: dedupKey,
      },
    });
  }

  /**
   * Resolve an existing PagerDuty incident.
   *
   * @param dedupKey - Deduplication key of the incident to resolve.
   * @returns The PagerDuty API response.
   */
  async resolve(dedupKey: string): Promise<PagerDutyEventResponse> {
    return this.sendEvent({
      event_action: 'resolve',
      payload: {
        summary: 'Incident resolved by automated runbook',
        severity: 'info',
        source: 'iot-billing-backend',
        dedup_key: dedupKey,
      },
    });
  }

  /**
   * Send a raw event to the PagerDuty Events API.
   *
   * @param event - The event payload to send.
   * @returns The PagerDuty API response.
   */
  async sendEvent(event: {
    event_action: PagerDutyAction;
    payload: Omit<PagerDutyEventPayload, 'event_action'>;
  }): Promise<PagerDutyEventResponse> {
    const body = {
      routing_key: this.routingKey,
      event_action: event.event_action,
      payload: {
        ...event.payload,
        timestamp: event.payload.timestamp ?? new Date().toISOString(),
      },
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(`${this.apiBaseUrl}/enqueue`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const responseBody = (await response.json()) as PagerDutyEventResponse;

        if (response.ok) {
          return responseBody;
        }

        // Handle retryable status codes.
        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < this.maxRetries) {
          lastError = new Error(
            `PagerDuty API returned ${response.status}: ${responseBody.message ?? 'Unknown error'}`,
          );
          await this.sleep(this.getBackoffDelay(attempt));
          continue;
        }

        // Non-retryable error.
        return {
          status: 'failure',
          dedup_key: event.payload.dedup_key,
          message: responseBody.message ?? `HTTP ${response.status}`,
          errors: responseBody.errors ?? [`HTTP ${response.status}`],
        };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new Error(`PagerDuty API request timed out after ${this.timeoutMs}ms`);
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
      dedup_key: event.payload.dedup_key,
      message: lastError?.message ?? 'Max retries exceeded',
      errors: lastError ? [lastError.message] : ['Max retries exceeded'],
    };
  }

  /**
   * Calculate exponential backoff delay with jitter.
   */
  private getBackoffDelay(attempt: number): number {
    const baseDelay = this.retryBaseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * this.retryBaseDelayMs;
    return Math.min(baseDelay + jitter, 30_000); // Cap at 30 seconds
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}