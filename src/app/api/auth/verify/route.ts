import { NextRequest, NextResponse } from 'next/server';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { nonceStore, sessionStore } from '../sessionStore';

function generateJWT(publicKey: string, expiresAt: number): string {
  // Simple JWT-like token (in production, use proper JWT library with signing)
  const payload = Buffer.from(
    JSON.stringify({
      sub: publicKey,
      exp: Math.floor(expiresAt / 1000),
      iat: Math.floor(Date.now() / 1000),
    }),
  ).toString('base64url');

  const signature = createHash('sha256')
    .update(payload + process.env.JWT_SECRET || 'dev-secret-change-in-production')
    .digest('base64url');

  return `${payload}.${signature}`;
}

function verifySignature(publicKey: string, message: string, signature: string): boolean {
  try {
    // For Stellar, the signature verification requires the Stellar SDK
    // The Freighter wallet signs with the private key
    // We need to verify the signature matches the public key

    // Convert signature from hex to Buffer
    const signatureBuffer = Buffer.from(signature, 'hex');
    const messageBuffer = Buffer.from(message, 'utf-8');

    // Verify using Stellar SDK
    const keypair = Keypair.fromPublicKey(publicKey);
    return keypair.verify(messageBuffer, signatureBuffer);
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { publicKey, signedChallenge, nonce } = body;

    // Validate inputs
    if (!publicKey || !signedChallenge || !nonce) {
      return NextResponse.json(
        { error: 'publicKey, signedChallenge, and nonce are required' },
        { status: 400 },
      );
    }

    // Validate Stellar public key format
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      return NextResponse.json({ error: 'Invalid Stellar public key' }, { status: 400 });
    }

    // Check if nonce exists and is valid
    const storedNonce = nonceStore.get(publicKey);
    if (!storedNonce) {
      return NextResponse.json({ error: 'Nonce not found or expired' }, { status: 401 });
    }

    if (storedNonce.nonce !== nonce) {
      return NextResponse.json({ error: 'Invalid nonce' }, { status: 401 });
    }

    if (Date.now() > storedNonce.expiresAt) {
      nonceStore.delete(publicKey);
      return NextResponse.json({ error: 'Nonce expired' }, { status: 401 });
    }

    // Verify the signature
    const isValid = verifySignature(publicKey, nonce, signedChallenge);
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // Delete used nonce to prevent replay attacks
    nonceStore.delete(publicKey);

    // Create session
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    const jwt = generateJWT(publicKey, expiresAt);

    sessionStore.set(publicKey, {
      jwt,
      expiresAt,
      lastHeartbeat: Date.now(),
    });

    const session = {
      nonce,
      signedChallenge,
      jwt,
      expiresAt,
      publicKey,
    };

    return NextResponse.json(session, { status: 200 });
  } catch (error) {
    console.error('Error verifying signature:', error);
    return NextResponse.json({ error: 'Failed to verify signature' }, { status: 500 });
  }
}
