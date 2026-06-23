import { NextRequest, NextResponse } from 'next/server';
import { sessionStore } from '../sessionStore';
import { generateJWT, getPublicKeyFromJWT } from '../tokenUtils';

export async function POST(request: NextRequest) {
  try {
    const { publicKey, jwt } = await request.json();
    if (!publicKey || !jwt) {
      return NextResponse.json({ error: 'publicKey and jwt are required' }, { status: 400 });
    }

    if (getPublicKeyFromJWT(jwt) !== publicKey) {
      return NextResponse.json({ error: 'Invalid JWT subject' }, { status: 401 });
    }

    const existing = sessionStore.get(publicKey);
    if (!existing || existing.jwt !== jwt) {
      return NextResponse.json({ error: 'Session not found' }, { status: 401 });
    }

    const expiresAt = Date.now() + 15 * 60 * 1000;
    const nextJwt = generateJWT(publicKey, expiresAt);
    sessionStore.set(publicKey, { jwt: nextJwt, expiresAt, lastHeartbeat: Date.now() });

    return NextResponse.json({
      jwt: nextJwt,
      expiresAt,
      publicKey,
      nonce: '',
      signedChallenge: '',
    });
  } catch {
    return NextResponse.json({ error: 'Failed to refresh token' }, { status: 500 });
  }
}
