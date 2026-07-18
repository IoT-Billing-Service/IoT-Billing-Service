import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunbookEngine } from '../../../src/incident_response/runbook_engine.js';
import { PagerDutyClient } from '../../../src/incident_response/pagerduty_client.js';
import type { DetectedIncident, RunbookDefinition } from '../../../src/incident_response/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createTestIncident(overrides: Partial<DetectedIncident> = {}): DetectedIncident {
  return {
    id: 'test-incident-1',
    title: 'Test incident',
    description: 'A test incident for unit testing',
    severity: 'critical',
    source: 'health_check',
    detectionRule: 'test_rule',
    detectedAt: new Date().toISOString(),
    dedupKey: 'test-dedup-key',
    context: { key: 'value', count: 42 },
    ...overrides,
  };
}

function createSimpleRunbook(overrides: Partial<RunbookDefinition> = {}): RunbookDefinition {
  return {
    name: 'test_runbook',
    description: 'A test runbook',
    version: '1.0.0',
    appliesTo: ['health_check'],
    severities: ['critical'],
    autoAcknowledge: false,
    autoResolve: false,
    timeoutMs: 60000,
    steps: [],
    tags: ['test'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunbookEngine', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor and basic state', () => {
    it('should create an engine with default options', () => {
      const engine = new RunbookEngine();
      expect(engine.getActiveExecutionCount()).toBe(0);
      expect(engine.getExecutionHistory()).toEqual([]);
    });

    it('should create an engine with custom options', () => {
      const engine = new RunbookEngine({
        maxConcurrentExecutions: 5,
        maxHistoryRecords: 100,
      });
      expect(engine.getActiveExecutionCount()).toBe(0);
    });
  });

  describe('execute with empty runbook', () => {
    it('should complete successfully with no steps', async () => {
      const engine = new RunbookEngine();
      const incident = createTestIncident();
      const runbook = createSimpleRunbook();

      const result = await engine.execute(runbook, incident);

      expect(result.status).toBe('completed');
      expect(result.runbookName).toBe('test_runbook');
      expect(result.incident.id).toBe('test-incident-1');
      expect(result.steps).toEqual([]);
      expect(result.executionId).toBeDefined();
      expect(result.startedAt).toBeDefined();
      expect(result.finishedAt).toBeDefined();
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('should record execution in history', async () => {
      const engine = new RunbookEngine();
      const result = await engine.execute(createSimpleRunbook(), createTestIncident());

      const history = engine.getExecutionHistory();
      expect(history).toHaveLength(1);
      expect(history[0]?.executionId).toBe(result.executionId);
    });

    it('should retrieve execution by ID', async () => {
      const engine = new RunbookEngine();
      const result = await engine.execute(createSimpleRunbook(), createTestIncident());

      const retrieved = engine.getExecution(result.executionId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.executionId).toBe(result.executionId);
    });
  });

  describe('concurrency limits', () => {
    it('should reject executions when at max concurrency', async () => {
      const engine = new RunbookEngine({ maxConcurrentExecutions: 1 });

      // Create a runbook with a sleep step to keep it running
      const slowRunbook = createSimpleRunbook({
        steps: [
          {
            name: 'wait',
            type: 'sleep',
            durationMs: 500,
          },
        ],
      });

      // Start first execution (don't await)
      const promise1 = engine.execute(slowRunbook, createTestIncident());

      // Give the first execution a moment to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Second execution should be rejected immediately
      const result2 = await engine.execute(createSimpleRunbook(), createTestIncident());
      expect(result2.status).toBe('failed');
      expect(result2.error).toContain('Max concurrent executions');

      // Wait for first to complete
      await promise1;
    });
  });

  describe('sleep step', () => {
    it('should execute a sleep step', async () => {
      const engine = new RunbookEngine();
      const runbook = createSimpleRunbook({
        steps: [
          {
            name: 'wait_10ms',
            type: 'sleep',
            durationMs: 10,
          },
        ],
      });

      const result = await engine.execute(runbook, createTestIncident());
      expect(result.status).toBe('completed');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.status).toBe('completed');
      expect(result.steps[0]?.stepType).toBe('sleep');
    });
  });

  describe('notification step', () => {
    it('should execute a notification step', async () => {
      const engine = new RunbookEngine();
      const runbook = createSimpleRunbook({
        steps: [
          {
            name: 'notify_slack',
            type: 'notification',
            channel: 'slack',
            message: 'Test notification for {{title}}',
            target: '#test-channel',
          },
        ],
      });

      const result = await engine.execute(runbook, createTestIncident());
      expect(result.status).toBe('completed');
      expect(result.steps[0]?.status).toBe('completed');
      expect(result.steps[0]?.output).toBeDefined();
    });

    it('should substitute template variables in notification', async () => {
      const engine = new RunbookEngine();
      const runbook = createSimpleRunbook({
        steps: [
          {
            name: 'notify',
            type: 'notification',
            channel: 'slack',
            message: 'Incident: {{title}}, Severity: {{severity}}',
            target: '#test',
          },
        ],
      });

      const result = await engine.execute(runbook, createTestIncident());
      expect(result.status).toBe('completed');
    });
  });

  describe('conditional step', () => {
    it('should execute the true branch when condition is met', async () => {
      const engine = new RunbookEngine();
      const runbook = createSimpleRunbook({
        steps: [
          {
            name: 'check_severity',
            type: 'conditional',
            condition: 'severity == "critical"',
            ifTrue: [
              {
                name: 'critical_action',
                type: 'sleep',
                durationMs: 1,
              },
            ],
            ifFalse: [
              {
                name: 'non_critical_action',
                type: 'sleep',
                durationMs: 1,
              },
            ],
          },
        ],
      });

      const result = await engine.execute(runbook, createTestIncident());
      expect(result.status).toBe('completed');
      expect(result.steps[0]?.status).toBe('completed');
    });

    it('should execute the false branch when condition is not met', async () => {
      const engine = new RunbookEngine();
      const runbook = createSimpleRunbook({
        steps: [
          {
            name: 'check_severity',
            type: 'conditional',
            condition: 'severity == "info"',
            ifTrue: [
              {
                name: 'info_action',
                type: 'sleep',
                durationMs: 1,
              },
            ],
            ifFalse: [
              {
                name: 'non_info_action',
                type: 'sleep',
                durationMs: 1,
              },
            ],
          },
        ],
      });

      const result = await engine.execute(runbook, createTestIncident());
      expect(result.status).toBe('completed');
    });
  });

  describe('parallel step', () => {
    it('should execute steps in parallel', async () => {
      const engine = new RunbookEngine();
      const runbook = createSimpleRunbook({
        steps: [
          {
            name: 'parallel_tasks',
            type: 'parallel',
            waitForAll: true,
            steps: [
              { name: 'task1', type: 'sleep', durationMs: 1 },
              { name: 'task2', type: 'sleep', durationMs: 1 },
              { name: 'task3', type: 'sleep', durationMs: 1 },
            ],
          },
        ],
      });

      const result = await engine.execute(runbook, createTestIncident());
      expect(result.status).toBe('completed');
    });
  });

  describe('PagerDuty integration', () => {
    it('should trigger PagerDuty incident on execution', async () => {
      const mockClient = {
        trigger: vi.fn().mockResolvedValue({
          status: 'success',
          dedup_key: 'test-dedup',
          message: 'Event processed',
        }),
        acknowledge: vi.fn().mockResolvedValue({
          status: 'success',
          dedup_key: 'test-dedup',
          message: 'Event acknowledged',
        }),
        resolve: vi.fn().mockResolvedValue({
          status: 'success',
          dedup_key: 'test-dedup',
          message: 'Event resolved',
        }),
        sendEvent: vi.fn(),
      };

      const engine = new RunbookEngine({
        pagerDutyClient: mockClient as unknown as PagerDutyClient,
      });

      const runbook = createSimpleRunbook({
        autoAcknowledge: true,
        autoResolve: true,
      });

      const result = await engine.execute(runbook, createTestIncident());

      expect(mockClient.trigger).toHaveBeenCalledTimes(1);
      expect(mockClient.acknowledge).toHaveBeenCalledTimes(1);
      expect(mockClient.resolve).toHaveBeenCalledTimes(1);
      expect(result.pagerDutyEvents).toBeDefined();
      expect(result.pagerDutyEvents).toHaveLength(3);
    });

    it('should not trigger PagerDuty when no client is configured', async () => {
      const engine = new RunbookEngine();
      const result = await engine.execute(createSimpleRunbook(), createTestIncident());

      expect(result.pagerDutyEvents).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should handle unknown step types', async () => {
      const engine = new RunbookEngine();
      const runbook = createSimpleRunbook({
        steps: [
          {
            name: 'unknown_step',
            type: 'http_request' as const,
            method: 'GET',
            url: 'http://nonexistent.example.com',
            timeoutMs: 100,
          },
        ],
      });

      const result = await engine.execute(runbook, createTestIncident());
      expect(result.status).toBe('failed');
    });
  });

  describe('execution history limits', () => {
    it('should limit history to maxHistoryRecords', async () => {
      const engine = new RunbookEngine({ maxHistoryRecords: 2 });

      await engine.execute(createSimpleRunbook(), createTestIncident());
      await engine.execute(createSimpleRunbook(), createTestIncident());
      await engine.execute(createSimpleRunbook(), createTestIncident());

      expect(engine.getExecutionHistory()).toHaveLength(2);
    });
  });
});