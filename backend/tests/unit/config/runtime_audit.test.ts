import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeConfiguration,
  RuntimeConfigurationAuditor,
  type RuntimeConfigurationAuditEvent,
  RuntimeConfigurationIntegrityError,
  type SignedRuntimeConfiguration,
} from '../../../src/config/runtime_audit.js';

interface BillingConfig {
  rates: { standard: number; peak: number };
}

function signedEnvelope(config: BillingConfig): {
  envelope: SignedRuntimeConfiguration<BillingConfig>;
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const unsigned = {
    algorithm: 'ed25519' as const,
    issuedAt: '2026-07-20T00:00:00.000Z',
    keyId: 'billing-config-release-1',
    payload: config,
    versionId: '2026-07-20.1',
  };
  const bytes = Buffer.from(canonicalizeConfiguration(unsigned));
  return {
    publicKey,
    envelope: { ...unsigned, signature: sign(null, bytes, privateKey).toString('base64') },
  };
}

describe('RuntimeConfigurationAuditor', (): void => {
  it('accepts an Ed25519-signed baseline and permits the matching runtime state', (): void => {
    const active = { rates: { standard: 10, peak: 15 } };
    const { envelope, publicKey } = signedEnvelope(active);
    const auditor = new RuntimeConfigurationAuditor({
      readActiveConfiguration: (): BillingConfig => active,
      authorizedKeys: new Map([[envelope.keyId, publicKey]]),
    });

    auditor.activate(envelope);

    expect((): void => {
      auditor.assertTrusted();
    }).not.toThrow();
    expect(auditor.getStatus()).toEqual({ status: 'healthy', versionId: envelope.versionId });
  });

  it('rejects an envelope whose payload was changed after signing', (): void => {
    const active = { rates: { standard: 10, peak: 15 } };
    const { envelope, publicKey } = signedEnvelope(active);
    envelope.payload.rates.peak = 999;
    const auditor = new RuntimeConfigurationAuditor({
      readActiveConfiguration: (): BillingConfig => active,
      authorizedKeys: new Map([[envelope.keyId, publicKey]]),
    });

    expect((): void => {
      auditor.activate(envelope);
    }).toThrow(RuntimeConfigurationIntegrityError);
    expect(auditor.getStatus().status).toBe('unverified');
  });

  it('detects in-memory drift once and blocks every subsequent billing check', (): void => {
    const active = { rates: { standard: 10, peak: 15 } };
    const { envelope, publicKey } = signedEnvelope(active);
    const auditSink = vi.fn();
    const auditor = new RuntimeConfigurationAuditor({
      readActiveConfiguration: (): BillingConfig => active,
      authorizedKeys: new Map([[envelope.keyId, publicKey]]),
      auditSink,
    });
    auditor.activate(envelope);

    active.rates.standard = 1; // simulated out-of-band runtime memory mutation

    expect((): void => {
      auditor.assertTrusted();
    }).toThrow('runtime configuration drift detected');
    expect((): void => {
      auditor.assertTrusted();
    }).toThrow('runtime configuration is not verified');
    expect(auditor.getStatus().status).toBe('drifted');
    expect(
      auditSink.mock.calls.filter(
        (call: unknown[]) =>
          (call[0] as RuntimeConfigurationAuditEvent).event === 'runtime_config_drift_detected',
      ),
    ).toHaveLength(1);
  });

  it('uses deterministic key ordering in the signed representation', (): void => {
    expect(canonicalizeConfiguration({ b: 2, a: { y: true, x: false } })).toBe(
      canonicalizeConfiguration({ a: { x: false, y: true }, b: 2 }),
    );
  });
});
