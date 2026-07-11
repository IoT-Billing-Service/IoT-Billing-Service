import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TxStatusPill, TxStatusList } from './TxStatusPill';
import { TX_STATUS_CLASSES, TX_STATUS_FALLBACK_CLASSES } from '@/lib/statusClasses';
import type { PendingTransaction } from '@/services/indexedDbCache';

describe('TxStatusPill', () => {
  it('should render pending status correctly', () => {
    const tx: PendingTransaction = {
      id: 'tx-1',
      hash: 'hash-pending',
      contractId: 'contract-1',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GTEST',
      type: 'escrow_deposit',
      status: 'pending',
      retryCount: 0,
      maxRetries: 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    render(<TxStatusPill transaction={tx} />);

    expect(screen.getByText('Submitted (pending confirmation)')).toBeInTheDocument();
    expect(screen.getByText('⏳')).toBeInTheDocument();
  });

  it('should render confirmed status with ledger number', () => {
    const tx: PendingTransaction = {
      id: 'tx-2',
      hash: 'hash-confirmed',
      contractId: 'contract-1',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GTEST',
      type: 'escrow_deposit',
      status: 'confirmed',
      retryCount: 0,
      maxRetries: 10,
      lastScannedLedger: 1000000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    render(<TxStatusPill transaction={tx} />);

    expect(screen.getByText('Confirmed on ledger 1000000')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('should render confirmed status without ledger number', () => {
    const tx: PendingTransaction = {
      id: 'tx-3',
      hash: 'hash-confirmed-no-ledger',
      contractId: 'contract-1',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GTEST',
      type: 'escrow_deposit',
      status: 'confirmed',
      retryCount: 0,
      maxRetries: 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    render(<TxStatusPill transaction={tx} />);

    expect(screen.getByText('Confirmed')).toBeInTheDocument();
  });

  it('should render failed status with retry count', () => {
    const tx: PendingTransaction = {
      id: 'tx-4',
      hash: 'hash-failed',
      contractId: 'contract-1',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GTEST',
      type: 'escrow_deposit',
      status: 'failed',
      retryCount: 2,
      maxRetries: 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    render(<TxStatusPill transaction={tx} />);

    expect(screen.getByText('Failed - retry 2/10')).toBeInTheDocument();
    expect(screen.getByText('✗')).toBeInTheDocument();
  });

  it('should display timestamp for pending transactions', () => {
    const now = Date.now();
    const tx: PendingTransaction = {
      id: 'tx-5',
      hash: 'hash-timestamp',
      contractId: 'contract-1',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GTEST',
      type: 'escrow_deposit',
      status: 'pending',
      retryCount: 0,
      maxRetries: 10,
      createdAt: now,
      updatedAt: now,
    };

    render(<TxStatusPill transaction={tx} />);

    // Check that a timestamp is displayed (format will vary by locale)
    const timeString = new Date(now).toLocaleTimeString();
    expect(screen.getByText(timeString)).toBeInTheDocument();
  });
});

describe('TxStatusList', () => {
  it('should render nothing when no transactions', () => {
    const { container } = render(<TxStatusList transactions={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('should render multiple transactions', () => {
    const transactions: PendingTransaction[] = [
      {
        id: 'tx-1',
        hash: 'hash1',
        contractId: 'contract-1',
        amount: '1000',
        asset: 'USDC',
        publicKey: 'GTEST',
        type: 'escrow_deposit',
        status: 'pending',
        retryCount: 0,
        maxRetries: 10,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'tx-2',
        hash: 'hash2',
        contractId: 'contract-2',
        amount: '2000',
        asset: 'XLM',
        publicKey: 'GTEST',
        type: 'escrow_withdrawal',
        status: 'confirmed',
        retryCount: 0,
        maxRetries: 10,
        lastScannedLedger: 1000000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    render(<TxStatusList transactions={transactions} />);

    expect(screen.getByText('Transaction Status')).toBeInTheDocument();
    expect(screen.getByText('Deposit')).toBeInTheDocument();
    expect(screen.getByText('Withdrawal')).toBeInTheDocument();
    expect(screen.getByText(/1000 USDC/)).toBeInTheDocument();
    expect(screen.getByText(/2000 XLM/)).toBeInTheDocument();
  });

  it('should show "Clear completed" button when there are completed transactions', () => {
    const transactions: PendingTransaction[] = [
      {
        id: 'tx-1',
        hash: 'hash1',
        contractId: 'contract-1',
        amount: '1000',
        asset: 'USDC',
        publicKey: 'GTEST',
        type: 'escrow_deposit',
        status: 'pending',
        retryCount: 0,
        maxRetries: 10,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'tx-2',
        hash: 'hash2',
        contractId: 'contract-2',
        amount: '2000',
        asset: 'XLM',
        publicKey: 'GTEST',
        type: 'escrow_withdrawal',
        status: 'confirmed',
        retryCount: 0,
        maxRetries: 10,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    const onClearCompleted = vi.fn();
    render(<TxStatusList transactions={transactions} onClearCompleted={onClearCompleted} />);

    const clearButton = screen.getByText('Clear completed');
    expect(clearButton).toBeInTheDocument();

    fireEvent.click(clearButton);
    expect(onClearCompleted).toHaveBeenCalledTimes(1);
  });

  it('should not show "Clear completed" button when no completed transactions', () => {
    const transactions: PendingTransaction[] = [
      {
        id: 'tx-1',
        hash: 'hash1',
        contractId: 'contract-1',
        amount: '1000',
        asset: 'USDC',
        publicKey: 'GTEST',
        type: 'escrow_deposit',
        status: 'pending',
        retryCount: 0,
        maxRetries: 10,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    const onClearCompleted = vi.fn();
    render(<TxStatusList transactions={transactions} onClearCompleted={onClearCompleted} />);

    expect(screen.queryByText('Clear completed')).not.toBeInTheDocument();
  });

  it('should display transaction hashes (truncated)', () => {
    const transactions: PendingTransaction[] = [
      {
        id: 'tx-1',
        hash: 'abcdef1234567890abcdef1234567890',
        contractId: 'contract-1',
        amount: '1000',
        asset: 'USDC',
        publicKey: 'GTEST',
        type: 'escrow_deposit',
        status: 'pending',
        retryCount: 0,
        maxRetries: 10,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    render(<TxStatusList transactions={transactions} />);

    // Hash should be truncated
    expect(screen.getByText(/abcdef1234567890\.\.\./)).toBeInTheDocument();
  });

  it('should display correct transaction type labels', () => {
    const deposit: PendingTransaction = {
      id: 'tx-1',
      hash: 'hash1',
      contractId: 'contract-1',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GTEST',
      type: 'escrow_deposit',
      status: 'pending',
      retryCount: 0,
      maxRetries: 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const { rerender } = render(<TxStatusList transactions={[deposit]} />);
    expect(screen.getByText('Deposit')).toBeInTheDocument();

    const withdrawal: PendingTransaction = {
      ...deposit,
      id: 'tx-2',
      type: 'escrow_withdrawal',
    };

    rerender(<TxStatusList transactions={[withdrawal]} />);
    expect(screen.getByText('Withdrawal')).toBeInTheDocument();
  });
});

const BASE_TX: PendingTransaction = {
  id: 'color-tx',
  hash: 'colorhash',
  contractId: 'contract-1',
  amount: '100',
  asset: 'XLM',
  publicKey: 'GABC',
  type: 'escrow_deposit',
  status: 'pending',
  retryCount: 0,
  maxRetries: 3,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe('TxStatusPill color classes', () => {
  it.each([
    ['pending', TX_STATUS_CLASSES.pending],
    ['confirmed', TX_STATUS_CLASSES.confirmed],
    ['failed', TX_STATUS_CLASSES.failed],
  ] as const)(
    '%s status → wrapper carries the correct non-empty color classes',
    (status, expected) => {
      const { container } = render(<TxStatusPill transaction={{ ...BASE_TX, status }} />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(expected).toBeTruthy();
      for (const cls of expected.split(' ')) {
        expect(wrapper.classList.contains(cls)).toBe(true);
      }
    },
  );

  it('unknown (default) status → wrapper carries the fallback color classes', () => {
    const tx = { ...BASE_TX, status: 'unknown' as PendingTransaction['status'] };
    const { container } = render(<TxStatusPill transaction={tx} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(TX_STATUS_FALLBACK_CLASSES).toBeTruthy();
    for (const cls of TX_STATUS_FALLBACK_CLASSES.split(' ')) {
      expect(wrapper.classList.contains(cls)).toBe(true);
    }
  });
});
