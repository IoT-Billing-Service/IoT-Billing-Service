import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { nonceStore } from '../sessionStore';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const publicKey = searchParams.get('publicKey');

    if (!publicKey || typeof publicKey !== 'string') {
      return NextResponse.json({ error: 'publicKey is required' }, { status: 400 });
    }

    // Validate Stellar public key format (basic check)
    if (!publicKey.match(/^G[A-Z0-9]{55}$/)) {
      return NextResponse.json({ error: 'Invalid Stellar public key format' }, { status: 400 });
    }

    // Generate a cryptographically secure random nonce
    const nonce = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    // Store nonce for verification
    nonceStore.set(publicKey, { nonce, expiresAt });

    return NextResponse.json({ nonce }, { status: 200 });
  } catch (error) {
    console.error('Error generating nonce:', error);
    return NextResponse.json({ error: 'Failed to generate nonce' }, { status: 500 });
  }
}
