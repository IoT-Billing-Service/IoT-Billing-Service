import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const hash = searchParams.get('hash');

  if (!hash) {
    return NextResponse.json({ error: 'Transaction hash is required' }, { status: 400 });
  }

  try {
    // TODO: Replace with actual Soroban RPC call to check transaction status
    // For now, this is a mock implementation
    // In production, you would:
    // 1. Query the Soroban RPC endpoint with the transaction hash
    // 2. Check if the transaction has been included in a ledger
    // 3. Return the status and ledger number

    // Mock implementation - randomly simulate transaction progression
    const mockStatus = simulateTransactionStatus(hash);

    return NextResponse.json(mockStatus);
  } catch (error) {
    console.error('Error checking transaction status:', error);
    return NextResponse.json({ error: 'Failed to check transaction status' }, { status: 500 });
  }
}

// Mock function to simulate transaction status
// Replace this with actual Soroban RPC calls in production
function simulateTransactionStatus(hash: string): {
  status: 'pending' | 'confirmed' | 'failed';
  ledger?: number;
  hash: string;
} {
  // Use hash to create deterministic behavior for testing
  const hashNum = hash.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const elapsed = Date.now() - (hashNum % 60000); // Simulate elapsed time

  // Simulate confirmation after ~30 seconds
  if (elapsed > 30000) {
    return {
      status: 'confirmed',
      ledger: 1000000 + Math.floor(elapsed / 5000),
      hash,
    };
  }

  // Simulate failure 5% of the time
  if (hashNum % 20 === 0) {
    return {
      status: 'failed',
      hash,
    };
  }

  return {
    status: 'pending',
    hash,
  };
}
