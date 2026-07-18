/**
 * Incident Response Metrics — Prometheus instrumentation
 *
 * Tracks incident detection, PagerDuty events, runbook executions,
 * and step-level metrics for observability in Grafana dashboards.
 *
 * All metrics are prefixed with `incident_response_` for clear separation.
 */

import promClient from 'prom-client';

// ---------------------------------------------------------------------------
// Guard — skip registration if prom-client registry is not yet set up
// ---------------------------------------------------------------------------

function tryRegister<T extends promClient.Metric>(factory: () => T): T | null {
  try {
    return factory();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Total incidents detected, by source and severity. */
export const incidentsDetectedTotal = tryRegister(
  () =>
    new promClient.Counter({
      name: 'incident_response_detected_total',
      help: 'Total incidents detected, by source and severity',
      labelNames: ['source', 'severity'] as const,
    }),
);

/** Total incidents that triggered a runbook execution. */
export const incidentsTriggeredTotal = tryRegister(
  () =>
    new promClient.Counter({
      name: 'incident_response_triggered_total',
      help: 'Total incidents that triggered a runbook execution, by runbook name',
      labelNames: ['runbook'] as const,
    }),
);

/** Runbook execution results, by runbook name and status. */
export const runbookExecutionsTotal = tryRegister(
  () =>
    new promClient.Counter({
      name: 'incident_response_runbook_executions_total',
      help: 'Runbook execution results, by runbook name and status',
      labelNames: ['runbook', 'status'] as const,
    }),
);

/** Runbook execution duration in milliseconds. */
export const runbookExecutionDurationMs = tryRegister(
  () =>
    new promClient.Histogram({
      name: 'incident_response_runbook_duration_ms',
      help: 'Runbook execution duration in milliseconds',
      labelNames: ['runbook', 'status'] as const,
      buckets: [100, 500, 1000, 5000, 10000, 30000, 60000, 120000, 300000],
    }),
);

/** Step execution results, by step type and status. */
export const stepExecutionsTotal = tryRegister(
  () =>
    new promClient.Counter({
      name: 'incident_response_step_executions_total',
      help: 'Step execution results, by step type and status',
      labelNames: ['type', 'status'] as const,
    }),
);

/** PagerDuty API call results, by action and status. */
export const pagerDutyEventsTotal = tryRegister(
  () =>
    new promClient.Counter({
      name: 'incident_response_pagerduty_events_total',
      help: 'PagerDuty API call results, by action and status',
      labelNames: ['action', 'status'] as const,
    }),
);

/** PagerDuty API call duration in milliseconds. */
export const pagerDutyDurationMs = tryRegister(
  () =>
    new promClient.Histogram({
      name: 'incident_response_pagerduty_duration_ms',
      help: 'PagerDuty API call duration in milliseconds',
      labelNames: ['action'] as const,
      buckets: [50, 100, 200, 500, 1000, 2000, 5000],
    }),
);

/** Current number of active runbook executions. */
export const activeExecutions = tryRegister(
  () =>
    new promClient.Gauge({
      name: 'incident_response_active_executions',
      help: 'Current number of active runbook executions',
    }),
);

/** Total number of detection rule evaluation errors. */
export const detectionErrorsTotal = tryRegister(
  () =>
    new promClient.Counter({
      name: 'incident_response_detection_errors_total',
      help: 'Total detection rule evaluation errors',
      labelNames: ['rule'] as const,
    }),
);

// ---------------------------------------------------------------------------
// Setters
// ---------------------------------------------------------------------------

export function recordIncidentDetected(source: string, severity: string): void {
  incidentsDetectedTotal?.inc({ source, severity });
}

export function recordIncidentTriggered(runbook: string): void {
  incidentsTriggeredTotal?.inc({ runbook });
}

export function recordRunbookExecution(runbook: string, status: string, durationMs: number): void {
  runbookExecutionsTotal?.inc({ runbook, status });
  runbookExecutionDurationMs?.observe({ runbook, status }, durationMs);
}

export function recordStepExecution(type: string, status: string): void {
  stepExecutionsTotal?.inc({ type, status });
}

export function recordPagerDutyEvent(action: string, status: string, durationMs: number): void {
  pagerDutyEventsTotal?.inc({ action, status });
  pagerDutyDurationMs?.observe({ action }, durationMs);
}

export function setActiveExecutions(count: number): void {
  activeExecutions?.set(count);
}

export function recordDetectionError(rule: string): void {
  detectionErrorsTotal?.inc({ rule });
}