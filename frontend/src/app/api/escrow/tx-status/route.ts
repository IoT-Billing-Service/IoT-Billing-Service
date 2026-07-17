import { NextRequest, NextResponse } from 'next/server';
import { Server, Api } from '@stellar/stellar-sdk/rpc';

const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';

/** Stellar transaction hash is a 64-character lowercase hex string. */
const TX_HASH_RE = /^[0-9a-f]{64}$/i;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const hash = searchParams.get('hash');

  if (!hash) {
    return NextResponse.json({ error: 'Transaction hash is required' }, { status: 400 });
  }

  if (!TX_HASH_RE.test(hash)) {
    return NextResponse.json({ error: 'Invalid transaction hash format' }, { status: 400 });
  }

  try {
    const server = new Server(SOROBAN_RPC_URL);
    const txResponse = await server.getTransaction(hash);

    switch (txResponse.status) {
      case Api.GetTransactionStatus.SUCCESS:
        return NextResponse.json({
          status: 'confirmed' as const,
          ledger: txResponse.ledger,
          hash,
        });

      case Api.GetTransactionStatus.FAILED:
        return NextResponse.json({
          status: 'failed' as const,
          ledger: txResponse.ledger,
          hash,
        });

      case Api.GetTransactionStatus.NOT_FOUND:
      default:
        // Transaction not yet included in a ledger — still pending.
        return NextResponse.json({
          status: 'pending' as const,
          hash,
        });
    }
  } catch (error) {
    console.error('Error checking transaction status:', error);
    return NextResponse.json({ error: 'Failed to check transaction status' }, { status: 500 });
  }
}
