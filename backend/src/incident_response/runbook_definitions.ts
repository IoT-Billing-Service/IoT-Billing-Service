/**
 * Built-in Runbook Definitions
 *
 * Pre-defined runbooks for common incident scenarios on the IoT billing platform.
 * Each runbook is designed to handle a specific type of incident with automated
 * response steps.
 *
 * ## Available Runbooks
 * - slo_burn_rate_response: Responds to SLO burn rate alerts
 * - circuit_breaker_response: Handles circuit breaker state changes
 * - replication_lag_response: Manages replication lag incidents
 * - billing_anomaly_response: Responds to billing pipeline anomalies
 * - health_check_failure: Handles health check failures
 * - chaos_experiment_failure: Responds to chaos experiment failures
 * - consumer_group_lag_response: Responds to consumer group lag incidents (issue #66)
 */

import type {
  RunbookDefinition,
  RunbookStepConfig,
} from './types.js';

// ---------------------------------------------------------------------------
// Helper: Create a Slack notification step
// ---------------------------------------------------------------------------

function slackNotification(
  name: string,
  message: string,
  channel: string,
): RunbookStepConfig {
  return {
    name,
    type: 'notification',
    channel: 'slack',
    message,
    target: channel,
    description: `Send Slack notification to ${channel}`,
  };
}

// ---------------------------------------------------------------------------
// SLO Burn Rate Response
// ---------------------------------------------------------------------------

/**
 * Responds to SLO burn rate alerts by:
 * 1. Notifying the on-call Slack channel
 * 2. Checking billing operation latency
 * 3. Checking circuit breaker state
 * 4. Checking replication lag
 * 5. Running a billing pipeline health check
 * 6. Escalating if critical
 */
export const sloBurnRateResponse: RunbookDefinition = {
  name: 'slo_burn_rate_response',
  description: 'Automated response to SLO burn rate alerts for billing operations',
  version: '1.0.0',
  appliesTo: ['slo_burn_rate', 'prometheus_alert'],
  severities: ['critical', 'error', 'warning'],
  autoAcknowledge: true,
  autoResolve: true,
  timeoutMs: 300_000, // 5 minutes
  tags: ['slo', 'performance', 'billing'],
  steps: [
    slackNotification(
      'notify_oncall',
      '🚨 SLO burn rate alert: {{title}}\nSeverity: {{severity}}\nSource: {{source}}\nDescription: {{description}}',
      '#oncall-billing',
    ),
    {
      name: 'check_billing_latency',
      type: 'http_request',
      description: 'Check current billing operation P99 latency',
      method: 'GET',
      url: 'http://localhost:3000/metrics',
      timeoutMs: 10_000,
      retries: 2,
      expectedStatuses: [200],
    },
    {
      name: 'check_circuit_breakers',
      type: 'http_request',
      description: 'Check circuit breaker states',
      method: 'GET',
      url: 'http://localhost:3000/circuit-health',
      timeoutMs: 10_000,
      retries: 2,
      expectedStatuses: [200],
    },
    {
      name: 'check_replication_lag',
      type: 'http_request',
      description: 'Check replication lag metrics',
      method: 'GET',
      url: 'http://localhost:3000/health',
      timeoutMs: 10_000,
      retries: 2,
      expectedStatuses: [200],
    },
    {
      name: 'conditional_escalation',
      type: 'conditional',
      description: 'Escalate if severity is critical',
      condition: 'severity == "critical"',
      ifTrue: [
        slackNotification(
          'escalate_to_engineering',
          '🔴 CRITICAL SLO burn rate requires immediate engineering attention!\nIncident: {{title}}\nDedup Key: {{dedupKey}}',
          '#engineering-billing',
        ),
        {
          name: 'trigger_auto_scaling',
          type: 'http_request',
          description: 'Trigger auto-scaling to handle increased load',
          method: 'POST',
          url: 'http://localhost:3000/api/admin/scale-up',
          timeoutMs: 30_000,
          retries: 1,
          expectedStatuses: [200, 202],
          body: JSON.stringify({
            reason: 'SLO burn rate critical',
            incident_id: '{{id}}',
          }),
        },
      ],
      ifFalse: [
        slackNotification(
          'notify_team_lead',
          '⚠️ Warning: SLO burn rate elevated for {{title}}\nPlease investigate within 1 hour.',
          '#billing-team',
        ),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Circuit Breaker Response
// ---------------------------------------------------------------------------

/**
 * Responds to circuit breaker state changes by:
 * 1. Notifying the on-call channel
 * 2. Checking the circuit breaker queue depth
 * 3. Checking the dependent service health
 * 4. Attempting automatic recovery
 * 5. Escalating if the breaker stays open
 */
export const circuitBreakerResponse: RunbookDefinition = {
  name: 'circuit_breaker_response',
  description: 'Automated response to circuit breaker state changes',
  version: '1.0.0',
  appliesTo: ['circuit_breaker'],
  severities: ['critical', 'error'],
  autoAcknowledge: true,
  autoResolve: true,
  timeoutMs: 300_000,
  tags: ['circuit-breaker', 'resilience', 'blockchain'],
  steps: [
    slackNotification(
      'notify_oncall',
      '🔌 Circuit breaker opened: {{title}}\nSeverity: {{severity}}\nDescription: {{description}}',
      '#oncall-billing',
    ),
    {
      name: 'check_queue_depth',
      type: 'http_request',
      description: 'Check circuit breaker queue depth',
      method: 'GET',
      url: 'http://localhost:3000/circuit-health',
      timeoutMs: 10_000,
      retries: 2,
      expectedStatuses: [200],
    },
    {
      name: 'check_soroban_health',
      type: 'http_request',
      description: 'Check Soroban RPC endpoint health',
      method: 'GET',
      url: 'http://localhost:3000/health',
      timeoutMs: 10_000,
      retries: 3,
      expectedStatuses: [200],
    },
    {
      name: 'wait_for_recovery',
      type: 'sleep',
      description: 'Wait 30 seconds for automatic recovery',
      durationMs: 30_000,
    },
    {
      name: 'verify_recovery',
      type: 'http_request',
      description: 'Verify circuit breaker has recovered',
      method: 'GET',
      url: 'http://localhost:3000/circuit-health',
      timeoutMs: 10_000,
      retries: 1,
      expectedStatuses: [200],
    },
    {
      name: 'conditional_escalation',
      type: 'conditional',
      description: 'Escalate if circuit breaker is still open',
      condition: 'context.state == "2"',
      ifTrue: [
        slackNotification(
          'escalate_to_engineering',
          '🔴 Circuit breaker still open after recovery window!\nRequires manual intervention.',
          '#engineering-billing',
        ),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Replication Lag Response
// ---------------------------------------------------------------------------

/**
 * Responds to replication lag incidents by:
 * 1. Notifying the on-call channel
 * 2. Checking replication lag metrics
 * 3. Checking region availability
 * 4. Triggering failover if critical
 */
export const replicationLagResponse: RunbookDefinition = {
  name: 'replication_lag_response',
  description: 'Automated response to replication lag incidents',
  version: '1.0.0',
  appliesTo: ['replication_lag'],
  severities: ['critical', 'error', 'warning'],
  autoAcknowledge: true,
  autoResolve: true,
  timeoutMs: 300_000,
  tags: ['replication', 'dr', 'multi-region'],
  steps: [
    slackNotification(
      'notify_oncall',
      '🔄 Replication lag detected: {{title}}\nSeverity: {{severity}}\nDescription: {{description}}',
      '#oncall-billing',
    ),
    {
      name: 'check_lag_metrics',
      type: 'http_request',
      description: 'Check replication lag metrics from Prometheus',
      method: 'GET',
      url: 'http://localhost:3000/metrics',
      timeoutMs: 10_000,
      retries: 2,
      expectedStatuses: [200],
    },
    {
      name: 'check_region_health',
      type: 'http_request',
      description: 'Check secondary region health',
      method: 'GET',
      url: 'http://localhost:3000/health',
      timeoutMs: 10_000,
      retries: 2,
      expectedStatuses: [200],
    },
    {
      name: 'conditional_failover',
      type: 'conditional',
      description: 'Trigger failover if lag is critical',
      condition: 'severity == "critical"',
      ifTrue: [
        slackNotification(
          'initiate_failover',
          '🔄 Initiating planned failover due to critical replication lag.\nIncident: {{title}}',
          '#engineering-billing',
        ),
        {
          name: 'trigger_failover',
          type: 'http_request',
          description: 'Trigger planned failover to secondary region',
          method: 'POST',
          url: 'http://localhost:3000/api/admin/failover',
          timeoutMs: 60_000,
          retries: 1,
          expectedStatuses: [200, 202],
          body: JSON.stringify({
            type: 'planned',
            reason: 'Critical replication lag',
            incident_id: '{{id}}',
          }),
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Billing Anomaly Response
// ---------------------------------------------------------------------------

/**
 * Responds to billing pipeline anomalies by:
 * 1. Notifying the on-call channel
 * 2. Checking billing finalizer state
 * 3. Checking settlement cron state
 * 4. Running a billing cycle audit
 * 5. Freezing billing if critical
 */
export const billingAnomalyResponse: RunbookDefinition = {
  name: 'billing_anomaly_response',
  description: 'Automated response to billing pipeline anomalies',
  version: '1.0.0',
  appliesTo: ['billing_anomaly'],
  severities: ['critical', 'error'],
  autoAcknowledge: true,
  autoResolve: true,
  timeoutMs: 300_000,
  tags: ['billing', 'anomaly', 'pipeline'],
  steps: [
    slackNotification(
      'notify_oncall',
      '💰 Billing anomaly detected: {{title}}\nSeverity: {{severity}}\nDescription: {{description}}',
      '#oncall-billing',
    ),
    {
      name: 'check_billing_state',
      type: 'http_request',
      description: 'Check billing pipeline state',
      method: 'GET',
      url: 'http://localhost:3000/api/admin/sync-status',
      timeoutMs: 10_000,
      retries: 2,
      expectedStatuses: [200],
    },
    {
      name: 'run_billing_audit',
      type: 'database_query',
      description: 'Run billing cycle audit query',
      query: `
        SELECT state, COUNT(*) as count
        FROM billing_cycles
        WHERE updated_at > NOW() - INTERVAL '1 hour'
        GROUP BY state
        ORDER BY state
      `,
      timeoutMs: 30_000,
    },
    {
      name: 'conditional_freeze',
      type: 'conditional',
      description: 'Freeze billing pipeline if critical anomaly detected',
      condition: 'severity == "critical"',
      ifTrue: [
        slackNotification(
          'freeze_billing',
          '⏸️ Freezing billing pipeline due to critical anomaly.\nIncident: {{title}}',
          '#engineering-billing',
        ),
        {
          name: 'pause_settlement_cron',
          type: 'http_request',
          description: 'Pause the settlement cron to prevent further processing',
          method: 'POST',
          url: 'http://localhost:3000/api/admin/pause-settlement',
          timeoutMs: 10_000,
          retries: 2,
          expectedStatuses: [200, 202],
          body: JSON.stringify({
            reason: 'Critical billing anomaly',
            incident_id: '{{id}}',
          }),
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Health Check Failure Response
// ---------------------------------------------------------------------------

/**
 * Responds to health check failures by:
 * 1. Notifying the on-call channel
 * 2. Checking all health endpoints
 * 3. Checking database connectivity
 * 4. Checking Redis connectivity
 * 5. Attempting automatic recovery
 */
export const healthCheckFailureResponse: RunbookDefinition = {
  name: 'health_check_failure',
  description: 'Automated response to health check failures',
  version: '1.0.0',
  appliesTo: ['health_check', 'prometheus_alert'],
  severities: ['critical', 'error', 'warning'],
  autoAcknowledge: true,
  autoResolve: true,
  timeoutMs: 300_000,
  tags: ['health', 'infrastructure'],
  steps: [
    slackNotification(
      'notify_oncall',
      '🏥 Health check failure: {{title}}\nSeverity: {{severity}}\nDescription: {{description}}',
      '#oncall-billing',
    ),
    {
      name: 'check_health_endpoint',
      type: 'http_request',
      description: 'Check the main health endpoint',
      method: 'GET',
      url: 'http://localhost:3000/health',
      timeoutMs: 10_000,
      retries: 3,
      expectedStatuses: [200],
    },
    {
      name: 'check_aggregate_health',
      type: 'http_request',
      description: 'Check aggregate health endpoint',
      method: 'GET',
      url: 'http://localhost:3000/aggregate-health',
      timeoutMs: 10_000,
      retries: 2,
      expectedStatuses: [200],
    },
    {
      name: 'wait_for_recovery',
      type: 'sleep',
      description: 'Wait 15 seconds for automatic recovery',
      durationMs: 15_000,
    },
    {
      name: 'verify_recovery',
      type: 'http_request',
      description: 'Verify health has been restored',
      method: 'GET',
      url: 'http://localhost:3000/health',
      timeoutMs: 10_000,
      retries: 2,
      expectedStatuses: [200],
    },
    {
      name: 'conditional_escalation',
      type: 'conditional',
      description: 'Escalate if health check still failing',
      condition: 'severity == "critical"',
      ifTrue: [
        slackNotification(
          'escalate_to_engineering',
          '🔴 Health check still failing after recovery window!\nRequires immediate manual intervention.\nIncident: {{title}}',
          '#engineering-billing',
        ),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Chaos Experiment Failure Response
// ---------------------------------------------------------------------------

/**
 * Responds to chaos experiment failures by:
 * 1. Notifying the on-call channel
 * 2. Checking experiment metrics
 * 3. Checking for double finalization
 * 4. Checking for spurious computations
 * 5. Documenting the failure
 */
export const chaosExperimentFailureResponse: RunbookDefinition = {
  name: 'chaos_experiment_failure',
  description: 'Automated response to chaos experiment failures',
  version: '1.0.0',
  appliesTo: ['chaos_experiment'],
  severities: ['error', 'warning'],
  autoAcknowledge: true,
  autoResolve: true,
  timeoutMs: 300_000,
  tags: ['chaos', 'testing', 'resilience'],
  steps: [
    slackNotification(
      'notify_oncall',
      '🧪 Chaos experiment failure: {{title}}\nSeverity: {{severity}}\nDescription: {{description}}',
      '#chaos-engineering',
    ),
    {
      name: 'check_double_finalization',
      type: 'http_request',
      description: 'Check for double finalization events',
      method: 'GET',
      url: 'http://localhost:3000/metrics',
      timeoutMs: 10_000,
      retries: 2,
      expectedStatuses: [200],
    },
    {
      name: 'check_spurious_computations',
      type: 'http_request',
      description: 'Check for spurious billing computations',
      method: 'GET',
      url: 'http://localhost:3000/metrics',
      timeoutMs: 10_000,
      retries: 2,
      expectedStatuses: [200],
    },
    {
      name: 'document_failure',
      type: 'notification',
      channel: 'slack',
      message:
        '📝 Chaos experiment failure documented.\nExperiment: {{title}}\nPlease review and update the experiment design.',
      target: '#chaos-engineering',
      description: 'Document the failure for post-mortem analysis',
    },
  ],
};

// ---------------------------------------------------------------------------
// Consumer Group Lag Response (Issue #66)
// ---------------------------------------------------------------------------

/**
 * Responds to Redis Streams consumer group lag incidents by:
 * 1. Notifying the on-call Slack channel
 * 2. Checking pending entries count from Prometheus metrics
 * 3. Checking consumer group health
 * 4. Triggering auto-scaling to add consumer replicas if critical
 */
export const consumerGroupLagResponse: RunbookDefinition = {
  name: 'consumer_group_lag_response',
  description: 'Automated response to Redis Streams consumer group lag incidents',
  version: '1.0.0',
  appliesTo: ['consumer_group_lag', 'prometheus_alert'],
  severities: ['critical', 'error', 'warning'],
  autoAcknowledge: true,
  autoResolve: true,
  timeoutMs: 300_000,
  tags: ['consumer-lag', 'streams', 'auto-scaling'],
  steps: [
    slackNotification(
      'notify_oncall',
      '📊 Consumer group lag detected: {{title}}\nSeverity: {{severity}}\nDescription: {{description}}',
      '#oncall-billing',
    ),
    {
      name: 'check_pending_entries',
      type: 'http_request',
      description: 'Check consumer group pending entries from Prometheus',
      method: 'GET',
      url: 'http://localhost:3000/metrics',
      timeoutMs: 10_000,
      retries: 2,
      expectedStatuses: [200],
    },
    {
      name: 'check_consumer_health',
      type: 'http_request',
      description: 'Check consumer group health endpoint',
      method: 'GET',
      url: 'http://localhost:3000/health',
      timeoutMs: 10_000,
      retries: 2,
      expectedStatuses: [200],
    },
    {
      name: 'conditional_scaling',
      type: 'conditional',
      description: 'Trigger consumer auto-scaling if critical',
      condition: 'severity == "critical"',
      ifTrue: [
        slackNotification(
          'trigger_consumer_scaling',
          '⚡ Triggering consumer auto-scaling due to critical lag.\nIncident: {{title}}\nPending entries may require additional consumer replicas.',
          '#engineering-billing',
        ),
        {
          name: 'scale_consumers',
          type: 'http_request',
          description: 'Trigger HPA scale-up for consumer replicas',
          method: 'POST',
          url: 'http://localhost:3000/api/admin/scale-consumers',
          timeoutMs: 30_000,
          retries: 1,
          expectedStatuses: [200, 202],
          body: JSON.stringify({
            reason: 'Consumer group lag critical',
            incident_id: '{{id}}',
          }),
        },
      ],
      ifFalse: [
        slackNotification(
          'notify_team',
          '⚠️ Consumer group lag elevated.\nIncident: {{title}}\nMonitor the group and consider scaling if lag persists.',
          '#billing-team',
        ),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Runbook Registry
// ---------------------------------------------------------------------------

/**
 * All built-in runbook definitions.
 */
export const BUILTIN_RUNBOOKS: RunbookDefinition[] = [
  sloBurnRateResponse,
  circuitBreakerResponse,
  replicationLagResponse,
  billingAnomalyResponse,
  healthCheckFailureResponse,
  chaosExperimentFailureResponse,
  consumerGroupLagResponse,
];

/**
 * Map of runbook name to definition for quick lookup.
 */
export const BUILTIN_RUNBOOKS_BY_NAME: Record<string, RunbookDefinition> =
  Object.fromEntries(BUILTIN_RUNBOOKS.map((r) => [r.name, r]));
