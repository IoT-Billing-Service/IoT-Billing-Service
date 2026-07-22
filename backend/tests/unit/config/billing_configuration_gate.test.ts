import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  activateSignedRuntimeConfiguration,
  assertBillingConfigurationTrusted,
  configureRuntimeConfigurationAudit,
  getConfig,
} from '../../../src/config/index.js';
import { finalizeBillingCycle } from '../../../src/billing/finalizer.js';
import { InMemoryBillingCycleStore } from '../../../src/billing/billing_cycle_repository.js';
import {
  canonicalizeConfiguration,
  RuntimeConfigurationIntegrityError,
  type SignedRuntimeConfiguration,
} from '../../../src/config/runtime_audit.js';

interface SerializedConfig {
  version_id: string;
  tiers: Record<string, { min: number; max: number | null }>;
}

let releaseNumber = 0;

function activateTrustedBillingConfig(): void {
  releaseNumber += 1;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const versionId = `billing-release-${String(releaseNumber)}`;
  const payload: SerializedConfig = {
    version_id: versionId,
    tiers: {
      TIER_1: { min: 0, max: 1000 },
      TIER_2: { min: 1001, max: null },
    },
  };
  const unsigned = {
    algorithm: 'ed25519' as const,
    issuedAt: '2026-07-20T00:00:00.000Z',
    keyId: 'billing-release-test-key',
    payload,
    versionId,
  };
  const envelope: SignedRuntimeConfiguration<SerializedConfig> = {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalizeConfiguration(unsigned)), privateKey).toString(
      'base64',
    ),
  };

  configureRuntimeConfigurationAudit(new Map([[envelope.keyId, publicKey]]));
  activateSignedRuntimeConfiguration(envelope);
}

describe('billing configuration integrity gate', () => {
  it('allows a verified baseline through finalization', async () => {
    activateTrustedBillingConfig();
    const store = new InMemoryBillingCycleStore();
    store.seed('cycle-verified');
    const computeFinalization = vi.fn();

    const result = await finalizeBillingCycle(store, 'cycle-verified', { computeFinalization });

    expect(result.outcome).toBe('finalized');
    expect(computeFinalization).toHaveBeenCalledOnce();
  });

  it('blocks a tainted run before it reads or mutates billing state', async () => {
    activateTrustedBillingConfig();
    const readState = vi.fn();
    const store = { getCycle: readState } as unknown as InMemoryBillingCycleStore;
    const tier1 = getConfig().tiers['TIER_1'];
    if (tier1 === undefined) throw new Error('Test configuration is missing TIER_1');
    tier1.min = 999;

    await expect(finalizeBillingCycle(store, 'cycle-tainted')).rejects.toBeInstanceOf(
      RuntimeConfigurationIntegrityError,
    );
    expect(readState).not.toHaveBeenCalled();
    expect((): void => {
      assertBillingConfigurationTrusted();
    }).toThrow('runtime configuration is not verified');
  });
});
