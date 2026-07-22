/**
 * Incident Response Runbook Automation — Module Entry Point
 *
 * Integrates PagerDuty incident management with automated runbook execution
 * for the IoT billing platform. Provides:
 *
 * - PagerDuty Events API v2 client for triggering/acknowledging/resolving incidents
 * - Incident detection from multiple sources (Prometheus alerts, health checks,
 *   SLO burn rates, circuit breakers, replication lag, billing anomalies)
 * - Runbook engine with support for sequential, parallel, conditional, and
 *   rollback step execution
 * - 6 built-in runbooks for common incident scenarios
 * - Admin REST API for manual incident triggering and runbook management
 * - Prometheus metrics for observability
 *
 * ## Quick Start
 *
 * ```typescript
 * import { createIncidentResponseModule } from './incident_response/index.js';
 *
 * const { engine, detector, start, stop } = createIncidentResponseModule({
 *   pagerDuty: {
 *     routingKey: process.env['PAGERDUTY_ROUTING_KEY'] ?? '',
 *   },
 * });
 *
 * // Register routes with Fastify
 * import { registerIncidentResponseRoutes } from './incident_response/routes.js';
 * registerIncidentResponseRoutes(app, engine, detector);
 *
 * // Start detection
 * start();
 * ```
 *
 * ## Environment Variables
 * - `PAGERDUTY_ROUTING_KEY` — PagerDuty Events API v2 integration key
 * - `PAGERDUTY_API_BASE_URL` — Custom PagerDuty API endpoint (optional)
 * - `INCIDENT_DETECTION_INTERVAL_MS` — Detection polling interval (default: 30000)
 * - `INCIDENT_MAX_CONCURRENT_EXECUTIONS` — Max concurrent runbooks (default: 10)
 */

import { PagerDutyClient } from './pagerduty_client.js';
import { IncidentDetector, createSloBurnRateRule, createCircuitBreakerRule, createReplicationLagRule, createBillingAnomalyRule, createConsumerGroupLagRule } from './incident_detector.js';
import { RunbookEngine } from './runbook_engine.js';
import { BUILTIN_RUNBOOKS_BY_NAME } from './runbook_definitions.js';
import {
  recordIncidentDetected,
  recordIncidentTriggered,
  recordRunbookExecution,
  recordStepExecution,
  recordPagerDutyEvent,
  setActiveExecutions,
  recordDetectionError,
} from './metrics.js';
import type { IncidentResponseConfig, DetectedIncident, RunbookDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Module State
// ---------------------------------------------------------------------------

export interface IncidentResponseModule {
  /** PagerDuty client instance. */
  pagerDutyClient: PagerDutyClient;
  /** Incident detector instance. */
  detector: IncidentDetector;
  /** Runbook engine instance. */
  engine: RunbookEngine;
  /** Start the detection polling loop. */
  start: () => void;
  /** Stop the detection polling loop. */
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and initialize the incident response module.
 *
 * @param config - Configuration for the incident response module.
 * @returns The initialized module with start/stop controls.
 */
export function createIncidentResponseModule(
  config: IncidentResponseConfig,
): IncidentResponseModule {
  // Create PagerDuty client.
  const pagerDutyClient = new PagerDutyClient(config.pagerDuty);

  // Create runbook engine.
  const engine = new RunbookEngine({
    pagerDutyClient,
    maxConcurrentExecutions: config.maxConcurrentExecutions ?? 10,
    maxHistoryRecords: config.storage?.maxRecords ?? 1000,
  });

  // Create incident detector with callback to execute runbooks.
  const detector = new IncidentDetector(config, async (incident: DetectedIncident) => {
    recordIncidentDetected(incident.source, incident.severity);

    // Find matching runbook.
    const runbook = findMatchingRunbook(incident);
    if (runbook === undefined) {
      console.log(
        `[incident-response] No matching runbook for incident: ${incident.title} (source: ${incident.source}, severity: ${incident.severity})`,
      );
      return;
    }

    recordIncidentTriggered(runbook.name);
    console.log(
      `[incident-response] Executing runbook "${runbook.name}" for incident: ${incident.title}`,
    );

    const startTime = Date.now();
    const result = await engine.execute(runbook, incident);
    const durationMs = Date.now() - startTime;

    recordRunbookExecution(runbook.name, result.status, durationMs);
    setActiveExecutions(engine.getActiveExecutionCount());

    // Record step-level metrics.
    for (const step of result.steps) {
      recordStepExecution(step.stepType, step.status);
    }

    // Record PagerDuty event metrics.
    if (result.pagerDutyEvents !== undefined) {
      for (const pdEvent of result.pagerDutyEvents) {
        recordPagerDutyEvent(pdEvent.action, pdEvent.response.status, durationMs);
      }
    }

    console.log(
      `[incident-response] Runbook "${runbook.name}" completed with status: ${result.status} (${durationMs}ms)`,
    );
  });

  // Register built-in detection rules.
  registerBuiltinDetectionRules(detector);

  return {
    pagerDutyClient,
    detector,
    engine,
    start: () => detector.start(),
    stop: () => detector.stop(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the best matching runbook for an incident.
 *
 * Matches by source first, then by severity. Falls back to the first runbook
 * that matches either source or severity.
 */
function findMatchingRunbook(incident: DetectedIncident): RunbookDefinition | undefined {
  // If the incident has a suggested runbook, try that first.
  if (incident.suggestedRunbook !== undefined) {
    const suggested = BUILTIN_RUNBOOKS_BY_NAME[incident.suggestedRunbook];
    if (suggested !== undefined) return suggested;
  }

  // Find runbooks that match both source and severity.
  const exactMatches = Object.values(BUILTIN_RUNBOOKS_BY_NAME).filter(
    (r) => r.appliesTo.includes(incident.source) && r.severities.includes(incident.severity),
  );

  if (exactMatches.length > 0) return exactMatches[0];

  // Fall back to runbooks that match only the source.
  const sourceMatches = Object.values(BUILTIN_RUNBOOKS_BY_NAME).filter((r) =>
    r.appliesTo.includes(incident.source),
  );

  if (sourceMatches.length > 0) return sourceMatches[0];

  return undefined;
}

/**
 * Register built-in detection rules with the detector.
 */
function registerBuiltinDetectionRules(detector: IncidentDetector): void {
  // SLO burn rate rules (matching the existing slo_alerts.yml).
  detector.addRule(createSloBurnRateRule(14.4, '1h', 'critical'));
  detector.addRule(createSloBurnRateRule(6, '6h', 'warning'));
  detector.addRule(createSloBurnRateRule(1, '3d', 'info'));

  // Circuit breaker rules.
  detector.addRule(createCircuitBreakerRule('soroban', 'critical'));

  // Replication lag rules.
  detector.addRule(createReplicationLagRule(5000, 'warning'));
  detector.addRule(createReplicationLagRule(30000, 'critical'));

  // Billing anomaly rules.
  detector.addRule(createBillingAnomalyRule('double_finalization', 'critical'));
  detector.addRule(createBillingAnomalyRule('spurious_computation', 'error'));

  // Consumer group lag rules (issue #66).
  detector.addRule(createConsumerGroupLagRule(1000, 'warning'));
  detector.addRule(createConsumerGroupLagRule(10000, 'critical'));
}