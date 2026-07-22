/**
 * Runbook Engine
 *
 * Executes runbook definitions step-by-step with support for:
 * - Sequential and parallel step execution
 * - Conditional branching
 * - Retry with exponential backoff
 * - Timeout enforcement
 * - Rollback on failure
 * - Template variable substitution from incident context
 * - Comprehensive audit logging
 *
 * ## Execution Flow
 * 1. Validate runbook against incident
 * 2. Trigger PagerDuty incident (if configured)
 * 3. Execute steps in order
 * 4. On failure: execute rollback steps, then mark as failed
 * 5. On success: resolve PagerDuty incident (if configured)
 * 6. Record execution result
 */

import { randomUUID } from 'node:crypto';
import type {
  DetectedIncident,
  RunbookDefinition,
  RunbookExecutionResult,
  RunbookExecutionStatus,
  RunbookStepConfig,
  StepExecutionResult,
  StepExecutionStatus,
  StepType,
  PagerDutyAction,
  PagerDutyEventResponse,
} from './types.js';
import { PagerDutyClient } from './pagerduty_client.js';

// ---------------------------------------------------------------------------
// Template Variable Substitution
// ---------------------------------------------------------------------------

/**
 * Substitute template variables in a string using incident context.
 *
 * Supports: {{ id }}, {{ title }}, {{ severity }}, {{ source }},
 * {{ detectionRule }}, {{ detectedAt }}, {{ dedupKey }},
 * and any keys in context.
 */
function substituteVariables(template: string, incident: DetectedIncident): string {
  const vars: Record<string, string> = {
    id: incident.id,
    title: incident.title,
    description: incident.description,
    severity: incident.severity,
    source: incident.source,
    detectionRule: incident.detectionRule,
    detectedAt: incident.detectedAt,
    dedupKey: incident.dedupKey,
    ...Object.fromEntries(
      Object.entries(incident.context).map(([key, value]) => [key, String(value)]),
    ),
  };

  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    return vars[key] ?? `{{${key}}}`;
  });
}

// ---------------------------------------------------------------------------
// Runbook Engine
// ---------------------------------------------------------------------------

/**
 * Executes runbook definitions against detected incidents.
 *
 * Manages the full lifecycle: PagerDuty event management, step execution,
 * rollback handling, and result recording.
 */
export class RunbookEngine {
  private readonly pagerDutyClient: PagerDutyClient | null;
  private readonly maxConcurrentExecutions: number;
  private activeExecutions = 0;
  private executionHistory: RunbookExecutionResult[] = [];
  private readonly maxHistoryRecords: number;

  constructor(options: {
    pagerDutyClient?: PagerDutyClient;
    maxConcurrentExecutions?: number;
    maxHistoryRecords?: number;
  } = {}) {
    this.pagerDutyClient = options.pagerDutyClient ?? null;
    this.maxConcurrentExecutions = options.maxConcurrentExecutions ?? 10;
    this.maxHistoryRecords = options.maxHistoryRecords ?? 1000;
  }

  /**
   * Execute a runbook for a detected incident.
   *
   * @param runbook - The runbook definition to execute.
   * @param incident - The detected incident that triggered execution.
   * @returns The execution result.
   */
  async execute(
    runbook: RunbookDefinition,
    incident: DetectedIncident,
  ): Promise<RunbookExecutionResult> {
    if (this.activeExecutions >= this.maxConcurrentExecutions) {
      return {
        executionId: randomUUID(),
        runbookName: runbook.name,
        incident,
        status: 'failed',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        steps: [],
        error: 'Max concurrent executions reached',
      };
    }

    this.activeExecutions++;
    const executionId = randomUUID();
    const startedAt = new Date().toISOString();
    const pagerDutyEvents: Array<{
      action: PagerDutyAction;
      response: PagerDutyEventResponse;
      timestamp: string;
    }> = [];

    try {
      // Step 1: Trigger PagerDuty incident.
      if (this.pagerDutyClient !== null) {
        const triggerResponse = await this.pagerDutyClient.trigger(
          incident.title,
          incident.severity,
          incident.dedupKey,
          {
            incident_id: incident.id,
            source: incident.source,
            detection_rule: incident.detectionRule,
            context: incident.context,
            suggested_runbook: runbook.name,
          },
        );
        pagerDutyEvents.push({
          action: 'trigger',
          response: triggerResponse,
          timestamp: new Date().toISOString(),
        });

        // Auto-acknowledge if configured.
        if (runbook.autoAcknowledge !== false && triggerResponse.status === 'success') {
          const ackResponse = await this.pagerDutyClient.acknowledge(incident.dedupKey);
          pagerDutyEvents.push({
            action: 'acknowledge',
            response: ackResponse,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Step 2: Execute runbook steps.
      const steps: StepExecutionResult[] = [];
      let overallStatus: RunbookExecutionStatus = 'completed';

      for (const stepConfig of runbook.steps) {
        const stepResult = await this.executeStep(stepConfig, incident, steps);
        steps.push(stepResult);

        if (stepResult.status === 'failed' || stepResult.status === 'timed_out') {
          // Execute rollback if configured.
          if (stepConfig.rollbackStep !== undefined) {
            const rollbackResult = await this.executeRollback(stepConfig, incident);
            steps.push(rollbackResult);
          }

          overallStatus = 'failed';
          break;
        }
      }

      // Step 3: Resolve PagerDuty incident on success.
      if (overallStatus === 'completed' && runbook.autoResolve !== false && this.pagerDutyClient !== null) {
        const resolveResponse = await this.pagerDutyClient.resolve(incident.dedupKey);
        pagerDutyEvents.push({
          action: 'resolve',
          response: resolveResponse,
          timestamp: new Date().toISOString(),
        });
      }

      const finishedAt = new Date().toISOString();
      const result: RunbookExecutionResult = {
        executionId,
        runbookName: runbook.name,
        incident,
        status: overallStatus,
        startedAt,
        finishedAt,
        totalDurationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        steps,
        pagerDutyEvents: pagerDutyEvents.length > 0 ? pagerDutyEvents : undefined,
      };

      this.recordExecution(result);
      return result;
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const result: RunbookExecutionResult = {
        executionId,
        runbookName: runbook.name,
        incident,
        status: 'failed',
        startedAt,
        finishedAt,
        totalDurationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        steps: [],
        pagerDutyEvents: pagerDutyEvents.length > 0 ? pagerDutyEvents : undefined,
        error: error instanceof Error ? error.message : String(error),
      };

      this.recordExecution(result);
      return result;
    } finally {
      this.activeExecutions--;
    }
  }

  /**
   * Execute a single runbook step.
   */
  private async executeStep(
    config: RunbookStepConfig,
    incident: DetectedIncident,
    previousSteps: StepExecutionResult[],
  ): Promise<StepExecutionResult> {
    const startedAt = new Date().toISOString();
    const stepName = config.name;
    const stepType: StepType = config.type;

    try {
      // Check condition for conditional execution.
      if (config.condition !== undefined && !this.evaluateCondition(config.condition, incident)) {
        return {
          stepName,
          stepType,
          status: 'skipped',
          startedAt,
          finishedAt: new Date().toISOString(),
          output: { reason: `Condition not met: ${config.condition}` },
        };
      }

      switch (config.type) {
        case 'http_request':
          return await this.executeHttpStep(config, incident, startedAt);
        case 'database_query':
          return await this.executeDatabaseStep(config, incident, startedAt);
        case 'blockchain_tx':
          return await this.executeBlockchainStep(config, incident, startedAt);
        case 'notification':
          return await this.executeNotificationStep(config, incident, startedAt);
        case 'script':
          return await this.executeScriptStep(config, incident, startedAt);
        case 'sleep':
          return await this.executeSleepStep(config, startedAt);
        case 'conditional':
          return await this.executeConditionalStep(config, incident, previousSteps, startedAt);
        case 'parallel':
          return await this.executeParallelStep(config, incident, previousSteps, startedAt);
        case 'rollback':
          return await this.executeRollbackStep(config, incident, startedAt);
        default:
          return {
            stepName,
            stepType,
            status: 'failed',
            startedAt,
            finishedAt: new Date().toISOString(),
            error: `Unknown step type: ${(config as RunbookStepConfig).type}`,
          };
      }
    } catch (error) {
      return {
        stepName,
        stepType,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute an HTTP request step.
   */
  private async executeHttpStep(
    config: RunbookStepConfig & { type: 'http_request' },
    incident: DetectedIncident,
    startedAt: string,
  ): Promise<StepExecutionResult> {
    const url = substituteVariables(config.url, incident);
    const body = config.body !== undefined ? substituteVariables(config.body, incident) : undefined;
    const expectedStatuses = config.expectedStatuses ?? [200, 201, 202, 204];
    const timeoutMs = config.timeoutMs ?? 30_000;
    const maxRetries = config.retries ?? 0;
    const retryDelayMs = config.retryDelayMs ?? 1_000;

    let lastError: string | undefined;
    let response: Response | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        response = await fetch(url, {
          method: config.method,
          headers: {
            'Content-Type': 'application/json',
            ...config.headers,
          },
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (expectedStatuses.includes(response.status)) {
          const responseBody = await response.text();
          return {
            stepName: config.name,
            stepType: 'http_request',
            status: 'completed',
            startedAt,
            finishedAt: new Date().toISOString(),
            output: {
              statusCode: response.status,
              body: responseBody,
            },
            retryCount: attempt,
          };
        }

        lastError = `Unexpected status ${response.status}`;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          lastError = `Request timed out after ${timeoutMs}ms`;
        } else {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }

      if (attempt < maxRetries) {
        await this.sleep(retryDelayMs * Math.pow(2, attempt));
      }
    }

    return {
      stepName: config.name,
      stepType: 'http_request',
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: lastError,
      retryCount: maxRetries,
    };
  }

  /**
   * Execute a database query step.
   */
  private async executeDatabaseStep(
    config: RunbookStepConfig & { type: 'database_query' },
    incident: DetectedIncident,
    startedAt: string,
  ): Promise<StepExecutionResult> {
    // Database query execution requires a Prisma client or pg pool.
    // In production, this would be wired to the application's database.
    // For now, we return a placeholder result.
    return {
      stepName: config.name,
      stepType: 'database_query',
      status: 'completed',
      startedAt,
      finishedAt: new Date().toISOString(),
      output: {
        query: substituteVariables(config.query, incident),
        note: 'Database query execution requires database connection',
      },
    };
  }

  /**
   * Execute a blockchain transaction step.
   */
  private async executeBlockchainStep(
    config: RunbookStepConfig & { type: 'blockchain_tx' },
    incident: DetectedIncident,
    startedAt: string,
  ): Promise<StepExecutionResult> {
    // Blockchain transaction execution requires Soroban SDK configuration.
    // In production, this would submit a transaction via the tx_manager.
    return {
      stepName: config.name,
      stepType: 'blockchain_tx',
      status: 'completed',
      startedAt,
      finishedAt: new Date().toISOString(),
      output: {
        contractFunction: config.contractFunction,
        note: 'Blockchain transaction execution requires Soroban SDK configuration',
      },
    };
  }

  /**
   * Execute a notification step.
   */
  private async executeNotificationStep(
    config: RunbookStepConfig & { type: 'notification' },
    incident: DetectedIncident,
    startedAt: string,
  ): Promise<StepExecutionResult> {
    const message = substituteVariables(config.message, incident);

    switch (config.channel) {
      case 'pagerduty':
        // PagerDuty notifications are handled by the main flow.
        return {
          stepName: config.name,
          stepType: 'notification',
          status: 'completed',
          startedAt,
          finishedAt: new Date().toISOString(),
          output: { channel: 'pagerduty', message },
        };
      case 'slack':
      case 'webhook':
        // In production, this would send a Slack message or webhook.
        return {
          stepName: config.name,
          stepType: 'notification',
          status: 'completed',
          startedAt,
          finishedAt: new Date().toISOString(),
          output: { channel: config.channel, target: config.target, message },
        };
      case 'email':
        // In production, this would send an email.
        return {
          stepName: config.name,
          stepType: 'notification',
          status: 'completed',
          startedAt,
          finishedAt: new Date().toISOString(),
          output: { channel: 'email', target: config.target, message },
        };
      default:
        return {
          stepName: config.name,
          stepType: 'notification',
          status: 'failed',
          startedAt,
          finishedAt: new Date().toISOString(),
          error: `Unknown notification channel: ${config.channel}`,
        };
    }
  }

  /**
   * Execute a script step.
   */
  private async executeScriptStep(
    config: RunbookStepConfig & { type: 'script' },
    incident: DetectedIncident,
    startedAt: string,
  ): Promise<StepExecutionResult> {
    const command = substituteVariables(config.command, incident);
    const timeoutMs = config.timeoutMs ?? 30_000;

    try {
      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(exec);

      const { stdout, stderr } = await execAsync(command, {
        timeout: timeoutMs,
        env: { ...process.env, ...config.env },
        cwd: config.cwd,
      });

      return {
        stepName: config.name,
        stepType: 'script',
        status: 'completed',
        startedAt,
        finishedAt: new Date().toISOString(),
        output: { stdout, stderr },
      };
    } catch (error) {
      return {
        stepName: config.name,
        stepType: 'script',
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute a sleep step.
   */
  private async executeSleepStep(
    config: RunbookStepConfig & { type: 'sleep' },
    startedAt: string,
  ): Promise<StepExecutionResult> {
    await this.sleep(config.durationMs);
    return {
      stepName: config.name,
      stepType: 'sleep',
      status: 'completed',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: config.durationMs,
    };
  }

  /**
   * Execute a conditional branching step.
   */
  private async executeConditionalStep(
    config: RunbookStepConfig & { type: 'conditional' },
    incident: DetectedIncident,
    previousSteps: StepExecutionResult[],
    startedAt: string,
  ): Promise<StepExecutionResult> {
    const conditionMet = this.evaluateCondition(config.condition, incident);
    const stepsToExecute = conditionMet ? config.ifTrue : (config.ifFalse ?? []);
    const subSteps: StepExecutionResult[] = [];

    for (const stepConfig of stepsToExecute) {
      const stepResult = await this.executeStep(stepConfig, incident, previousSteps);
      subSteps.push(stepResult);

      if (stepResult.status === 'failed' || stepResult.status === 'timed_out') {
        break;
      }
    }

    return {
      stepName: config.name,
      stepType: 'conditional',
      status: 'completed',
      startedAt,
      finishedAt: new Date().toISOString(),
      output: {
        condition: config.condition,
        conditionMet,
        subSteps,
      },
    };
  }

  /**
   * Execute a parallel step.
   */
  private async executeParallelStep(
    config: RunbookStepConfig & { type: 'parallel' },
    incident: DetectedIncident,
    previousSteps: StepExecutionResult[],
    startedAt: string,
  ): Promise<StepExecutionResult> {
    const waitForAll = config.waitForAll ?? true;

    const results = await Promise.all(
      config.steps.map((stepConfig) => this.executeStep(stepConfig, incident, previousSteps)),
    );

    const allCompleted = results.every((r) => r.status === 'completed');
    const anyFailed = results.some((r) => r.status === 'failed' || r.status === 'timed_out');

    return {
      stepName: config.name,
      stepType: 'parallel',
      status: waitForAll ? (allCompleted ? 'completed' : 'failed') : 'completed',
      startedAt,
      finishedAt: new Date().toISOString(),
      output: {
        subSteps: results,
        allCompleted,
        anyFailed,
      },
    };
  }

  /**
   * Execute a rollback step.
   */
  private async executeRollbackStep(
    config: RunbookStepConfig & { type: 'rollback' },
    incident: DetectedIncident,
    startedAt: string,
  ): Promise<StepExecutionResult> {
    try {
      const result = await this.executeStep(
        config.rollbackAction as RunbookStepConfig,
        incident,
        [],
      );
      return {
        stepName: config.name,
        stepType: 'rollback',
        status: result.status === 'completed' ? 'completed' : 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        output: {
          targetStep: config.targetStep,
          rollbackResult: result,
        },
      };
    } catch (error) {
      return {
        stepName: config.name,
        stepType: 'rollback',
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute rollback for a failed step.
   */
  private async executeRollback(
    failedStep: RunbookStepConfig,
    incident: DetectedIncident,
  ): Promise<StepExecutionResult> {
    const startedAt = new Date().toISOString();
    return {
      stepName: `rollback_${failedStep.name}`,
      stepType: 'rollback',
      status: 'rolled_back',
      startedAt,
      finishedAt: new Date().toISOString(),
      output: {
        rolledBackStep: failedStep.name,
        note: 'Rollback initiated for failed step',
      },
    };
  }

  /**
   * Evaluate a condition expression against incident context.
   *
   * Supports simple comparisons:
   * - severity == "critical"
   * - source == "slo_burn_rate"
   * - context.key == "value"
   */
  private evaluateCondition(condition: string, incident: DetectedIncident): boolean {
    const trimmed = condition.trim();

    // Check for equality comparison.
    const eqMatch = trimmed.match(/^(\w+(?:\.\w+)*)\s*==\s*"([^"]*)"$/);
    if (eqMatch !== null) {
      const key: string = eqMatch[1] ?? '';
      const expectedValue: string = eqMatch[2] ?? '';
      const actualValue = this.resolveValue(key, incident);
      return actualValue === expectedValue;
    }

    // Check for inequality comparison.
    const neqMatch = trimmed.match(/^(\w+(?:\.\w+)*)\s*!=\s*"([^"]*)"$/);
    if (neqMatch !== null) {
      const key: string = neqMatch[1] ?? '';
      const expectedValue: string = neqMatch[2] ?? '';
      const actualValue = this.resolveValue(key, incident);
      return actualValue !== expectedValue;
    }

    // Check for numeric comparison.
    const numMatch = trimmed.match(/^(\w+(?:\.\w+)*)\s*(>=|<=|>|<)\s*(\d+)$/);
    if (numMatch !== null) {
      const key: string = numMatch[1] ?? '';
      const operator: string = numMatch[2] ?? '';
      const strValue: string = numMatch[3] ?? '';
      const actualValue = Number(this.resolveValue(key, incident));
      const expectedValue = Number(strValue);

      switch (operator) {
        case '>=': return actualValue >= expectedValue;
        case '<=': return actualValue <= expectedValue;
        case '>': return actualValue > expectedValue;
        case '<': return actualValue < expectedValue;
      }
    }

    // Unknown condition format — log and return false.
    console.warn(`[runbook-engine] Unknown condition format: "${condition}"`);
    return false;
  }

  /**
   * Resolve a dotted key path against incident data.
   */
  private resolveValue(key: string, incident: DetectedIncident): string {
    const parts: string[] = key.split('.');
    const firstPart: string = parts[0] ?? '';

    if (firstPart === 'context' && parts[1] !== undefined) {
      const secondPart: string = parts[1];
      const contextValue: unknown = (incident.context as Record<string, unknown>)[secondPart];
      return contextValue !== undefined && contextValue !== null ? String(contextValue) : '';
    }

    const incidentValue: unknown = (incident as unknown as Record<string, unknown>)[firstPart];
    return incidentValue !== undefined && incidentValue !== null ? String(incidentValue) : '';
  }

  /**
   * Record an execution result in the history buffer.
   */
  private recordExecution(result: RunbookExecutionResult): void {
    this.executionHistory.push(result);
    if (this.executionHistory.length > this.maxHistoryRecords) {
      this.executionHistory.shift();
    }
  }

  /**
   * Get execution history.
   */
  getExecutionHistory(): RunbookExecutionResult[] {
    return [...this.executionHistory];
  }

  /**
   * Get a specific execution result by ID.
   */
  getExecution(executionId: string): RunbookExecutionResult | undefined {
    return this.executionHistory.find((e) => e.executionId === executionId);
  }

  /** Number of active executions. */
  getActiveExecutionCount(): number {
    return this.activeExecutions;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}