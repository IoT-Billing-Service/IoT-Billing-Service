import { NextRequest, NextResponse } from 'next/server';
import { Server } from '@stellar/stellar-sdk/rpc';
import { SOROBAN_RPC_URL } from '@/utils/sorobanConfig';

type TransactionStatus = 'pending' | 'confirmed' | 'failed';

interface TransactionStatusPayload {
  status: TransactionStatus;
  ledger?: number;
  hash: string;
}

function normalizeTransactionStatus(rawStatus?: string): TransactionStatus {
  switch ((rawStatus ?? '').toUpperCase()) {
    case 'SUCCESS':
    case 'CONFIRMED':
      return 'confirmed';
    case 'FAILED':
    case 'ERROR':
      return 'failed';
    default:
      return 'pending';
  }
}

export async function GET(request: NextRequest) {
  const hash = request.nextUrl.searchParams.get('hash');

  if (!hash) {
    return NextResponse.json({ error: 'Transaction hash is required' }, { status: 400 });
  }

  try {
    const rpcUrl =
      process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? process.env.SOROBAN_RPC_URL ?? SOROBAN_RPC_URL;
    const server = new Server(rpcUrl);
    const tx = await server.getTransaction(hash);

    const status = normalizeTransactionStatus((tx as { status?: string } | undefined)?.status);
    const ledger = (tx as { ledger?: unknown } | undefined)?.ledger;

    const payload: TransactionStatusPayload = {
      status,
      hash,
      ...(typeof ledger === 'number' ? { ledger } : {}),
    };

    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.toLowerCase().includes('not found') || message.toLowerCase().includes('404')) {
      return NextResponse.json({ status: 'pending', hash } satisfies TransactionStatusPayload);
    }

    console.error('Error checking transaction status:', error);
    return NextResponse.json({ error: 'Failed to check transaction status' }, { status: 500 });
  }
}
