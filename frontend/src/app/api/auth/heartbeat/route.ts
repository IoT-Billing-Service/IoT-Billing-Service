import { NextRequest, NextResponse } from 'next/server';
import { sessionStore } from '../sessionStore';

const HEARTBEAT_TIMEOUT = 60_000; // 60 seconds

function extractJWTFromHeader(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1] ?? null;
}

function getPublicKeyFromJWT(jwt: string): string | null {
  try {
    // Extract payload from our simple JWT format
    const parts = jwt.split('.');
    const payload = parts[0];
    if (!payload) return null;

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return decoded.sub || null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    const jwt = extractJWTFromHeader(authHeader);

    if (!jwt) {
      return NextResponse.json({ error: 'Authorization header required' }, { status: 401 });
    }

    // Extract public key from JWT
    const publicKey = getPublicKeyFromJWT(jwt);
    if (!publicKey) {
      return NextResponse.json({ error: 'Invalid JWT format' }, { status: 401 });
    }

    // Check if session exists
    const session = sessionStore.get(publicKey);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 401 });
    }

    // Verify JWT matches
    if (session.jwt !== jwt) {
      return NextResponse.json({ error: 'Invalid JWT' }, { status: 401 });
    }

    // Check if session expired
    if (Date.now() > session.expiresAt) {
      sessionStore.delete(publicKey);
      return NextResponse.json({ error: 'Session expired' }, { status: 401 });
    }

    // Check if last heartbeat was too long ago
    if (Date.now() - session.lastHeartbeat > HEARTBEAT_TIMEOUT) {
      sessionStore.delete(publicKey);
      return NextResponse.json({ error: 'Session timeout due to inactivity' }, { status: 401 });
    }

    // Update last heartbeat
    session.lastHeartbeat = Date.now();
    sessionStore.set(publicKey, session);

    return NextResponse.json(
      { success: true, lastHeartbeat: session.lastHeartbeat },
      { status: 200 },
    );
  } catch (error) {
    console.error('Error processing heartbeat:', error);
    return NextResponse.json({ error: 'Failed to process heartbeat' }, { status: 500 });
  }
}
