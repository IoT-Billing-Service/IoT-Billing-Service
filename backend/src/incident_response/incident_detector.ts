/**
 * Incident Detector
 *
 * Monitors various detection sources (Prometheus alerts, health checks,
 * SLO burn rates, circuit breakers, replication lag, billing anomalies)
 * and creates DetectedIncident objects that trigger runbook execution.
 *
 * ## Detection Sources
 * - Prometheus alert webhooks
 * - Health check failures
 * - SLO burn rate alerts
 * - Circuit breaker state changes
 * - Replication lag thresholds
 * - Billing pipeline anomalies
 * - Chaos experiment failures
 * - Manual (API-triggered)
 */

import { randomUUID } from 'node:crypto';
import type {
  DetectedIncident,
  DetectionSource,
  IncidentSeverity,
  IncidentResponseConfig,
} from './types.js';

// ---------------------------------------------------------------------------
// Detection Rule
// ---------------------------------------------------------------------------

/** A rule that evaluates a condition and produces incidents. */
export interface DetectionRule {
  /** Unique name for this rule. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Source identifier. */
  source: DetectionSource;
  /** Severity to assign. */
  severity: IncidentSeverity;
  /** Suggested runbook to execute. */
  suggestedRunbook?: string;
  /** Evaluation function: returns a DetectedIncident or null if no incident. */
  evaluate: () => Promise<DetectedIncident | null>;
}

// ---------------------------------------------------------------------------
// Incident Detector
// ---------------------------------------------------------------------------

/**
 * Monitors detection rules and emits incidents when conditions are met.
 *
 * Runs a polling loop that evaluates all registered rules at a configurable
 * interval. Each detected incident is emitted via the `onIncident` callback
 * for processing by the runbook engine.
 */
export class IncidentDetector {
  private rules: DetectionRule[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly detectionIntervalMs: number;
  private readonly onIncident: (incident: DetectedIncident) => Promise<void>;
  private totalDetections = 0;
  private totalErrors = 0;

  constructor(
    config: IncidentResponseConfig,
    onIncident: (incident: DetectedIncident) => Promise<void>,
  ) {
    this.detectionIntervalMs = config.detectionIntervalMs ?? 30_000;
    this.onIncident = onIncident;
  }

  /**
   * Register a detection rule.
   */
  addRule(rule: DetectionRule): void {
    this.rules.push(rule);
  }

  /**
   * Register multiple detection rules at once.
   */
  addRules(rules: DetectionRule[]): void {
    this.rules.push(...rules);
  }

  /**
   * Start the detection polling loop.
   */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.detectionIntervalMs);
    this.timer.unref();
  }

  /**
   * Stop the detection polling loop.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single detection poll cycle.
   * Returns the number of incidents detected.
   */
  async poll(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    let detected = 0;
    try {
      for (const rule of this.rules) {
        try {
          const incident = await rule.evaluate();
          if (incident !== null) {
            detected++;
            this.totalDetections++;
            // Fire and forget — the runbook engine handles execution.
            void this.onIncident(incident);
          }
        } catch (error) {
          this.totalErrors++;
          console.error(
            `[incident-detector] Rule "${rule.name}" evaluation failed:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } finally {
      this.running = false;
    }

    return detected;
  }

  /**
   * Manually create an incident (for API-triggered incidents).
   */
  createManualIncident(
    title: string,
    description: string,
    severity: IncidentSeverity,
    context: Record<string, unknown> = {},
    suggestedRunbook?: string,
  ): DetectedIncident {
    const id = randomUUID();
    return {
      id,
      title,
      description,
      severity,
      source: 'manual',
      detectionRule: 'manual_trigger',
      detectedAt: new Date().toISOString(),
      dedupKey: `manual_${id}`,
      context,
      suggestedRunbook,
    };
  }

  /** Total number of incidents detected since start. */
  getTotalDetections(): number {
    return this.totalDetections;
  }

  /** Total number of rule evaluation errors. */
  getTotalErrors(): number {
    return this.totalErrors;
  }

  /** Number of registered rules. */
  getRuleCount(): number {
    return this.rules.length;
  }
}

// ---------------------------------------------------------------------------
// Built-in Detection Rules
// ---------------------------------------------------------------------------

/**
 * Create a detection rule for SLO burn rate alerts.
 * Monitors the Prometheus SLO burn rate metrics and creates incidents
 * when burn rates exceed thresholds.
 */
export function createSloBurnRateRule(
  burnRateThreshold: number,
  windowLabel: string,
  severity: IncidentSeverity,
): DetectionRule {
  return {
    name: `slo_burn_rate_${windowLabel}`,
    description: `SLO burn rate alert for ${windowLabel} window`,
    source: 'slo_burn_rate',
    severity,
    suggestedRunbook: 'slo_burn_rate_response',
    evaluate: async (): Promise<DetectedIncident | null> => {
      // In production, this would query Prometheus for the burn rate metric.
      // For now, we return null (no incident) — the actual evaluation is
      // triggered by Prometheus Alertmanager webhooks.
      return null;
    },
  };
}

/**
 * Create a detection rule for circuit breaker state changes.
 */
export function createCircuitBreakerRule(
  clientName: string,
  severity: IncidentSeverity,
): DetectionRule {
  return {
    name: `circuit_breaker_${clientName}`,
    description: `Circuit breaker opened for client: ${clientName}`,
    source: 'circuit_breaker',
    severity,
    suggestedRunbook: 'circuit_breaker_response',
    evaluate: async (): Promise<DetectedIncident | null> => {
      // In production, this would check the circuit breaker state metric.
      return null;
    },
  };
}

/**
 * Create a detection rule for replication lag.
 */
export function createReplicationLagRule(
  maxLagMs: number,
  severity: IncidentSeverity,
): DetectionRule {
  return {
    name: `replication_lag_${maxLagMs}ms`,
    description: `Replication lag exceeds ${maxLagMs}ms threshold`,
    source: 'replication_lag',
    severity,
    suggestedRunbook: 'replication_lag_response',
    evaluate: async (): Promise<DetectedIncident | null> => {
      // In production, this would query the replication monitor.
      return null;
    },
  };
}

/**
 * Create a detection rule for billing pipeline anomalies.
 */
export function createBillingAnomalyRule(
  anomalyType: string,
  severity: IncidentSeverity,
): DetectionRule {
  return {
    name: `billing_anomaly_${anomalyType}`,
    description: `Billing pipeline anomaly detected: ${anomalyType}`,
    source: 'billing_anomaly',
    severity,
    suggestedRunbook: 'billing_anomaly_response',
    evaluate: async (): Promise<DetectedIncident | null> => {
      // In production, this would analyze billing metrics for anomalies.
      return null;
    },
  };
}

/**
 * Create a detection rule for consumer group lag.
 * Monitors the consumer group lag health gauge and creates incidents
 * when pending entries exceed configured thresholds.
 */
export function createConsumerGroupLagRule(
  pendingThreshold: number,
  severity: IncidentSeverity,
): DetectionRule {
  return {
    name: `consumer_group_lag_${pendingThreshold}`,
    description: `Consumer group pending entries exceed ${pendingThreshold} threshold`,
    source: 'consumer_group_lag',
    severity,
    suggestedRunbook: 'consumer_group_lag_response',
    evaluate: async (): Promise<DetectedIncident | null> => {
      // In production, this would query the consumer lag monitor or Prometheus.
      // The alert rules in billing_alerts.yml fire independently via Alertmanager.
      return null;
    },
  };
}