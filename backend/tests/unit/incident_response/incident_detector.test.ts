import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IncidentDetector, createSloBurnRateRule, createCircuitBreakerRule, createReplicationLagRule, createBillingAnomalyRule } from '../../../src/incident_response/incident_detector.js';
import type { IncidentResponseConfig, DetectedIncident } from '../../../src/incident_response/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConfig(overrides: Partial<IncidentResponseConfig> = {}): IncidentResponseConfig {
  return {
    pagerDuty: {
      routingKey: 'test-key',
    },
    detectionIntervalMs: 1000,
    maxConcurrentExecutions: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IncidentDetector', () => {
  let onIncident: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    onIncident = vi.fn();
  });

  describe('constructor and lifecycle', () => {
    it('should start and stop the detection loop', async () => {
      const detector = new IncidentDetector(createConfig(), onIncident);

      expect(detector.getRuleCount()).toBe(0);
      expect(detector.getTotalDetections()).toBe(0);
      expect(detector.getTotalErrors()).toBe(0);

      detector.start();
      detector.stop();
    });

    it('should be idempotent on start', () => {
      const detector = new IncidentDetector(createConfig(), onIncident);
      detector.start();
      detector.start(); // Should not throw
      detector.stop();
    });
  });

  describe('addRule', () => {
    it('should register and evaluate rules', async () => {
      const detector = new IncidentDetector(createConfig({ detectionIntervalMs: 5000 }), onIncident);

      detector.addRule({
        name: 'test_rule',
        description: 'Test rule',
        source: 'health_check',
        severity: 'critical',
        evaluate: async () => ({
          id: 'test-id',
          title: 'Test incident',
          description: 'Test description',
          severity: 'critical',
          source: 'health_check',
          detectionRule: 'test_rule',
          detectedAt: new Date().toISOString(),
          dedupKey: 'test-dedup',
          context: {},
        }),
      });

      expect(detector.getRuleCount()).toBe(1);

      const count = await detector.poll();
      expect(count).toBe(1);
      expect(detector.getTotalDetections()).toBe(1);
      expect(onIncident).toHaveBeenCalledTimes(1);
    });

    it('should handle rules that return null (no incident)', async () => {
      const detector = new IncidentDetector(createConfig(), onIncident);

      detector.addRule({
        name: 'noop_rule',
        description: 'No-op rule',
        source: 'health_check',
        severity: 'info',
        evaluate: async () => null,
      });

      const count = await detector.poll();
      expect(count).toBe(0);
      expect(onIncident).not.toHaveBeenCalled();
    });

    it('should handle rule evaluation errors gracefully', async () => {
      const detector = new IncidentDetector(createConfig(), onIncident);

      detector.addRule({
        name: 'error_rule',
        description: 'Error rule',
        source: 'health_check',
        severity: 'error',
        evaluate: async () => {
          throw new Error('Evaluation failed');
        },
      });

      const count = await detector.poll();
      expect(count).toBe(0);
      expect(detector.getTotalErrors()).toBe(1);
      expect(onIncident).not.toHaveBeenCalled();
    });

    it('should not run concurrent polls', async () => {
      const detector = new IncidentDetector(createConfig(), onIncident);

      let resolveRule: (value: DetectedIncident | null) => void;
      const rulePromise = new Promise<DetectedIncident | null>((resolve) => {
        resolveRule = resolve;
      });

      detector.addRule({
        name: 'slow_rule',
        description: 'Slow rule',
        source: 'health_check',
        severity: 'warning',
        evaluate: () => rulePromise,
      });

      // Start first poll
      const poll1 = detector.poll();

      // Second poll should return 0 immediately
      const poll2 = await detector.poll();
      expect(poll2).toBe(0);

      // Resolve first poll
      resolveRule!(null);
      await poll1;
    });
  });

  describe('createManualIncident', () => {
    it('should create a manual incident with correct fields', () => {
      const detector = new IncidentDetector(createConfig(), onIncident);

      const incident = detector.createManualIncident(
        'Manual test',
        'Created via API',
        'critical',
        { key: 'value' },
        'test_runbook',
      );

      expect(incident.title).toBe('Manual test');
      expect(incident.description).toBe('Created via API');
      expect(incident.severity).toBe('critical');
      expect(incident.source).toBe('manual');
      expect(incident.detectionRule).toBe('manual_trigger');
      expect(incident.context).toEqual({ key: 'value' });
      expect(incident.suggestedRunbook).toBe('test_runbook');
      expect(incident.id).toBeDefined();
      expect(incident.dedupKey).toContain('manual_');
    });
  });

  describe('built-in rule factories', () => {
    it('should create SLO burn rate rules', () => {
      const rule = createSloBurnRateRule(14.4, '1h', 'critical');
      expect(rule.name).toBe('slo_burn_rate_1h');
      expect(rule.source).toBe('slo_burn_rate');
      expect(rule.severity).toBe('critical');
      expect(rule.suggestedRunbook).toBe('slo_burn_rate_response');
    });

    it('should create circuit breaker rules', () => {
      const rule = createCircuitBreakerRule('soroban', 'critical');
      expect(rule.name).toBe('circuit_breaker_soroban');
      expect(rule.source).toBe('circuit_breaker');
      expect(rule.suggestedRunbook).toBe('circuit_breaker_response');
    });

    it('should create replication lag rules', () => {
      const rule = createReplicationLagRule(5000, 'warning');
      expect(rule.name).toBe('replication_lag_5000ms');
      expect(rule.source).toBe('replication_lag');
      expect(rule.suggestedRunbook).toBe('replication_lag_response');
    });

    it('should create billing anomaly rules', () => {
      const rule = createBillingAnomalyRule('double_finalization', 'critical');
      expect(rule.name).toBe('billing_anomaly_double_finalization');
      expect(rule.source).toBe('billing_anomaly');
      expect(rule.suggestedRunbook).toBe('billing_anomaly_response');
    });
  });
});