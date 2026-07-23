/**
 * Incident Response Runbook Automation — Type Definitions
 *
 * Defines the contracts for PagerDuty integration, incident detection,
 * runbook definitions, and automated response execution.
 *
 * ## Design Constraints
 * - P99 billing operations < 200ms (incident response must not add latency)
 * - All transactions cryptographically verified
 * - PCI-DSS / SOC2: incident response actions must be auditable
 */

// ---------------------------------------------------------------------------
// PagerDuty Integration
// ---------------------------------------------------------------------------

/** PagerDuty event action types (Events API v2). */
export type PagerDutyAction = 'trigger' | 'acknowledge' | 'resolve';

/** Severity levels aligned with PagerDuty's Common Event Format (CEF). */
export type IncidentSeverity = 'critical' | 'error' | 'warning' | 'info';

/** PagerDuty Events API v2 payload. */
export interface PagerDutyEventPayload {
  /** Summary of the incident (displayed in PagerDuty UI). */
  summary: string;
  /** Severity level. */
  severity: IncidentSeverity;
  /** Source of the event (e.g., "iot-billing-backend"). */
  source: string;
  /** Unique identifier for deduplication across retries. */
  dedup_key: string;
  /** Event action. */
  event_action: PagerDutyAction;
  /** Timestamp in ISO 8601 format. */
  timestamp?: string;
  /** Component that generated the event. */
  component?: string;
  /** Group of related events. */
  group?: string;
  /** Classification of the event type. */
  class?: string;
  /** Custom details payload. */
  custom_details?: Record<string, unknown>;
  /** Links to add to the incident. */
  links?: Array<{ href: string; text: string }>;
  /** Images to attach. */
  images?: Array<{ src: string; href: string; alt: string }>;
}

/** PagerDuty Events API v2 response. */
export interface PagerDutyEventResponse {
  /** Status of the event ingestion. */
  status: 'success' | 'failure';
  /** Deduplication key for the event. */
  dedup_key: string;
  /** Human-readable message. */
  message: string;
  /** Errors if status is failure. */
  errors?: string[];
}

/** PagerDuty client configuration. */
export interface PagerDutyConfig {
  /** PagerDuty Events API v2 integration key (routing key). */
  routingKey: string;
  /** Base URL for the Events API. Default: "https://events.pagerduty.com/v2" */
  apiBaseUrl?: string;
  /** Request timeout in milliseconds. Default: 10000 */
  timeoutMs?: number;
  /** Maximum retries for failed API calls. Default: 3 */
  maxRetries?: number;
  /** Retry backoff base delay in milliseconds. Default: 1000 */
  retryBaseDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Incident Detection
// ---------------------------------------------------------------------------

/** Sources that can trigger an incident. */
export type DetectionSource =
  | 'prometheus_alert'
  | 'health_check'
  | 'slo_burn_rate'
  | 'circuit_breaker'
  | 'replication_lag'
  | 'billing_anomaly'
  | 'consumer_group_lag'
  | 'chaos_experiment'
  | 'manual';

/** A detected incident ready for runbook execution. */
export interface DetectedIncident {
  [key: string]: unknown;
  /** Unique identifier for this incident occurrence. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Detailed description. */
  description: string;
  /** Severity level. */
  severity: IncidentSeverity;
  /** Source that detected this incident. */
  source: DetectionSource;
  /** The detection rule or alert name that fired. */
  detectionRule: string;
  /** Timestamp when the incident was detected. */
  detectedAt: string;
  /** PagerDuty deduplication key (derived from id). */
  dedupKey: string;
  /** Contextual data from the detection source. */
  context: Record<string, unknown>;
  /** Suggested runbook name to execute. */
  suggestedRunbook?: string;
  /** Whether this incident has been auto-resolved. */
  autoResolved?: boolean;
}

// ---------------------------------------------------------------------------
// Runbook Definitions
// ---------------------------------------------------------------------------

/** Types of runbook steps. */
export type StepType =
  | 'http_request'       // Make an HTTP request
  | 'database_query'     // Execute a database query
  | 'blockchain_tx'      // Submit a blockchain transaction
  | 'notification'       // Send a notification (Slack, email, etc.)
  | 'script'             // Execute a script or command
  | 'sleep'              // Wait for a duration
  | 'conditional'        // Conditional branching
  | 'parallel'           // Execute steps in parallel
  | 'rollback';          // Rollback previous steps

/** Base interface for all step configurations. */
export interface BaseStepConfig {
  /** Unique name for this step within the runbook. */
  name: string;
  /** Human-readable description. */
  description?: string;
  /** Step type. */
  type: StepType;
  /** Timeout in milliseconds. Default: 30000 */
  timeoutMs?: number;
  /** Number of retries on failure. Default: 0 */
  retries?: number;
  /** Retry delay in milliseconds. Default: 1000 */
  retryDelayMs?: number;
  /** Whether failure of this step should fail the entire runbook. Default: true */
  critical?: boolean;
  /** Condition expression for conditional execution (evaluated against incident context). */
  condition?: string;
  /** Reference to a rollback step name. */
  rollbackStep?: string;
}

/** HTTP request step configuration. */
export interface HttpRequestStepConfig extends BaseStepConfig {
  type: 'http_request';
  /** HTTP method. */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Request URL (supports template variables from incident context). */
  url: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Request body template (supports template variables). */
  body?: string;
  /** Expected HTTP status codes for success. Default: [200, 201, 202, 204] */
  expectedStatuses?: number[];
}

/** Database query step configuration. */
export interface DatabaseQueryStepConfig extends BaseStepConfig {
  type: 'database_query';
  /** SQL query template (supports template variables). */
  query: string;
  /** Query parameters. */
  params?: unknown[];
  /** Expected row count range for validation. */
  expectedRowCount?: { min?: number; max?: number };
}

/** Blockchain transaction step configuration. */
export interface BlockchainTxStepConfig extends BaseStepConfig {
  type: 'blockchain_tx';
  /** Contract function to invoke. */
  contractFunction: string;
  /** Arguments for the contract function. */
  args: Record<string, unknown>;
  /** Maximum fee in stroops. */
  maxFeeStroops?: bigint;
}

/** Notification step configuration. */
export interface NotificationStepConfig extends BaseStepConfig {
  type: 'notification';
  /** Notification channel. */
  channel: 'slack' | 'email' | 'webhook' | 'pagerduty';
  /** Message template. */
  message: string;
  /** Target (channel/webhook URL/email address). */
  target: string;
}

/** Script execution step configuration. */
export interface ScriptStepConfig extends BaseStepConfig {
  type: 'script';
  /** Command to execute. */
  command: string;
  /** Environment variables. */
  env?: Record<string, string>;
  /** Working directory. */
  cwd?: string;
}

/** Sleep/wait step configuration. */
export interface SleepStepConfig extends BaseStepConfig {
  type: 'sleep';
  /** Duration to sleep in milliseconds. */
  durationMs: number;
}

/** Conditional branching step configuration. */
export interface ConditionalStepConfig extends BaseStepConfig {
  type: 'conditional';
  /** Condition expression (evaluated against incident context). */
  condition: string;
  /** Steps to execute if condition is true. */
  ifTrue: RunbookStepConfig[];
  /** Steps to execute if condition is false (optional). */
  ifFalse?: RunbookStepConfig[];
}

/** Parallel execution step configuration. */
export interface ParallelStepConfig extends BaseStepConfig {
  type: 'parallel';
  /** Steps to execute in parallel. */
  steps: RunbookStepConfig[];
  /** Whether to wait for all steps to complete. Default: true */
  waitForAll?: boolean;
}

/** Rollback step configuration. */
export interface RollbackStepConfig extends BaseStepConfig {
  type: 'rollback';
  /** Name of the step to rollback. */
  targetStep: string;
  /** Rollback action configuration. */
  rollbackAction: HttpRequestStepConfig | DatabaseQueryStepConfig | BlockchainTxStepConfig;
}

/** Union of all step configuration types. */
export type RunbookStepConfig =
  | HttpRequestStepConfig
  | DatabaseQueryStepConfig
  | BlockchainTxStepConfig
  | NotificationStepConfig
  | ScriptStepConfig
  | SleepStepConfig
  | ConditionalStepConfig
  | ParallelStepConfig
  | RollbackStepConfig;

/** A complete runbook definition. */
export interface RunbookDefinition {
  /** Unique name for this runbook. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Version of this runbook definition. */
  version: string;
  /** The incident types this runbook applies to. */
  appliesTo: DetectionSource[];
  /** Severity levels this runbook handles. */
  severities: IncidentSeverity[];
  /** Whether to auto-acknowledge the PagerDuty incident on start. Default: true */
  autoAcknowledge?: boolean;
  /** Whether to auto-resolve the PagerDuty incident on successful completion. Default: true */
  autoResolve?: boolean;
  /** Maximum execution time for the entire runbook in milliseconds. Default: 300000 (5 min) */
  timeoutMs?: number;
  /** Steps to execute in order. */
  steps: RunbookStepConfig[];
  /** Tags for categorization. */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Runbook Execution
// ---------------------------------------------------------------------------

/** Status of a runbook execution. */
export type RunbookExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'rolled_back';

/** Status of a single step execution. */
export type StepExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'timed_out'
  | 'rolled_back';

/** Result of a single step execution. */
export interface StepExecutionResult {
  /** Step name. */
  stepName: string;
  /** Step type. */
  stepType: StepType;
  /** Execution status. */
  status: StepExecutionStatus;
  /** Start timestamp. */
  startedAt: string;
  /** End timestamp. */
  finishedAt?: string;
  /** Duration in milliseconds. */
  durationMs?: number;
  /** Output data from the step. */
  output?: unknown;
  /** Error message if failed. */
  error?: string;
  /** Number of retries attempted. */
  retryCount?: number;
}

/** Result of a complete runbook execution. */
export interface RunbookExecutionResult {
  /** Unique execution ID. */
  executionId: string;
  /** Runbook name that was executed. */
  runbookName: string;
  /** The incident that triggered this execution. */
  incident: DetectedIncident;
  /** Overall execution status. */
  status: RunbookExecutionStatus;
  /** Start timestamp. */
  startedAt: string;
  /** End timestamp. */
  finishedAt?: string;
  /** Total duration in milliseconds. */
  totalDurationMs?: number;
  /** Results of each step. */
  steps: StepExecutionResult[];
  /** PagerDuty event responses. */
  pagerDutyEvents?: Array<{
    action: PagerDutyAction;
    response: PagerDutyEventResponse;
    timestamp: string;
  }>;
  /** Error message if the runbook failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Incident Response Configuration
// ---------------------------------------------------------------------------

/** Configuration for the incident response module. */
export interface IncidentResponseConfig {
  /** PagerDuty configuration. */
  pagerDuty: PagerDutyConfig;
  /** Whether incident detection is enabled. Default: true */
  detectionEnabled?: boolean;
  /** Polling interval for detection sources in milliseconds. Default: 30000 */
  detectionIntervalMs?: number;
  /** Maximum number of concurrent runbook executions. Default: 10 */
  maxConcurrentExecutions?: number;
  /** Whether to enable auto-resolution of incidents. Default: true */
  autoResolveEnabled?: boolean;
  /** Grace period before auto-resolving after runbook completion (ms). Default: 60000 */
  autoResolveGracePeriodMs?: number;
  /** Storage backend for execution history. */
  storage?: {
    /** Maximum number of execution records to keep in memory. Default: 1000 */
    maxRecords?: number;
  };
}
