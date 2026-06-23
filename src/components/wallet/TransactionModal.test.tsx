import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TransactionModal } from './TransactionModal';

// Stable mock fns (hoisted so the vi.mock factories can reference them).
const mocks = vi.hoisted(() => ({
  estimate: vi.fn(),
  reset: vi.fn(),
  enqueue: vi.fn().mockResolvedValue('queued-id'),
  clearCompleted: vi.fn(),
}));

vi.mock('@/components/providers/WalletProvider', () => ({
  useWallet: () => ({
    metrics: { publicKey: 'GTEST', isConnected: true, network: 'testnet', balances: [] },
  }),
}));

vi.mock('@/hooks/useGasEstimate', () => ({
  useGasEstimate: () => ({
    feeBreakdown: null,
    estimating: false,
    simulationError: null,
    estimate: mocks.estimate,
    reset: mocks.reset,
  }),
}));

vi.mock('@/hooks/useTxRetryQueue', () => ({
  useTxRetryQueue: () => ({
    pendingTransactions: [],
    enqueue: mocks.enqueue,
    clearCompleted: mocks.clearCompleted,
  }),
}));

// Stub child components that have their own fetch/side effects.
vi.mock('./GasEstimator', () => ({ GasEstimator: () => null }));
vi.mock('./TxStatusPill', () => ({ TxStatusList: () => null }));

describe('TransactionModal submit', () => {
  beforeEach(() => {
    mocks.enqueue.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits exactly one escrow request even on rapid repeated clicks', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ hash: 'tx-hash' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <TransactionModal type="escrow_deposit" contractId="C-123" asset="USDC" onClose={() => {}} />,
    );

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '100' } });

    const submit = screen.getByRole('button', { name: 'Deposit' });

    // Three synchronous activations in one batch — the in-flight guard must
    // collapse them to a single escrow submission.
    await act(async () => {
      submit.click();
      submit.click();
      submit.click();
    });

    const escrowCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/escrow/'));
    expect(escrowCalls).toHaveLength(1);
    expect(escrowCalls[0]![0]).toContain('/api/escrow/deposit');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});
