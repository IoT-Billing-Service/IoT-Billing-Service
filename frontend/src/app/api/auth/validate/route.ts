import { NextRequest, NextResponse } from 'next/server';
import { sessionStore } from '../sessionStore';
import { extractJWTFromHeader, getPublicKeyFromJWT } from '../tokenUtils';

export async function HEAD(request: NextRequest) {
  const jwt = extractJWTFromHeader(request.headers.get('Authorization'));
  if (!jwt) return new NextResponse(null, { status: 401 });

  const publicKey = getPublicKeyFromJWT(jwt);
  if (!publicKey) return new NextResponse(null, { status: 401 });

  const session = sessionStore.get(publicKey);
  if (!session || session.jwt !== jwt || Date.now() > session.expiresAt) {
    return new NextResponse(null, { status: 401 });
  }

  session.lastHeartbeat = Date.now();
  sessionStore.set(publicKey, session);
  return new NextResponse(null, { status: 204 });
}
