import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

const { mockGetTransaction } = vi.hoisted(() => ({
  mockGetTransaction: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk/rpc', () => ({
  Server: vi.fn(function () {
    return {
      getTransaction: mockGetTransaction,
    };
  }),
}));

describe('GET /api/escrow/tx-status', () => {
  beforeEach(() => {
    mockGetTransaction.mockReset();
  });

  it('returns confirmed status from the Soroban RPC when the transaction succeeds', async () => {
    mockGetTransaction.mockResolvedValue({
      status: 'SUCCESS',
      ledger: 42,
    });

    const request = new NextRequest('http://localhost/api/escrow/tx-status?hash=test-hash');
    const response = await GET(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      status: 'confirmed',
      ledger: 42,
      hash: 'test-hash',
    });
  });

  it('returns pending status when the RPC reports the transaction is not found yet', async () => {
    mockGetTransaction.mockRejectedValue(new Error('not found'));

    const request = new NextRequest('http://localhost/api/escrow/tx-status?hash=test-pending');
    const response = await GET(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      status: 'pending',
      hash: 'test-pending',
    });
  });
});
