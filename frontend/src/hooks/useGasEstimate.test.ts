import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGasEstimate } from './useGasEstimate';

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = (await vi.importActual('@stellar/stellar-sdk')) as Record<string, unknown>;
  return { ...actual };
});

vi.mock('@stellar/stellar-sdk/rpc', async () => {
  const actual = (await vi.importActual('@stellar/stellar-sdk/rpc')) as Record<string, unknown>;
  return {
    ...actual,
    Api: {
      isSimulationSuccess: (r: Record<string, string>) => r.status === 'success',
      isSimulationError: (r: Record<string, string>) => r.status === 'error',
      isSimulationRestore: (r: Record<string, string>) => r.status === 'restore',
    },
  };
});

vi.mock('@/utils/sorobanConfig', () => ({
  SOROBAN_RPC_URL: 'https://testnet.example.com',
  CACHE_TTL_MS: 30_000,
  SIMULATION_TIMEOUT_MS: 3_000,
}));

vi.mock('@/utils/currencyFormatter', () => ({
  fromSorobanInt: (val: string) => (Number(val) / 10_000_000).toFixed(7),
  formatCurrency: (val: string | number) => Number(val).toFixed(2),
}));

vi.mock('@/utils/errorDecoder', () => ({
  ErrorDecoder: class {
    tryDecode(s: string) {
      return s;
    }
  },
}));

describe('useGasEstimate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns initial state', () => {
    const { result } = renderHook(() => useGasEstimate());
    expect(result.current.feeBreakdown).toBeNull();
    expect(result.current.estimating).toBe(false);
    expect(result.current.simulationError).toBeNull();
  });

  it('resets state on reset call', () => {
    const { result } = renderHook(() => useGasEstimate());
    act(() => {
      result.current.reset();
    });
    expect(result.current.feeBreakdown).toBeNull();
    expect(result.current.estimating).toBe(false);
    expect(result.current.simulationError).toBeNull();
  });
});
