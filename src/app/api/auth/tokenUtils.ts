import { createHash } from 'crypto';

export function generateJWT(publicKey: string, expiresAt: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub: publicKey,
      exp: Math.floor(expiresAt / 1000),
      iat: Math.floor(Date.now() / 1000),
    }),
  ).toString('base64url');

  const signature = createHash('sha256')
    .update(payload + (process.env.JWT_SECRET || 'dev-secret-change-in-production'))
    .digest('base64url');

  return `${payload}.${signature}`;
}

export function extractJWTFromHeader(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1] ?? null;
}

export function getPublicKeyFromJWT(jwt: string): string | null {
  try {
    const payload = jwt.split('.')[0];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return typeof decoded.sub === 'string' ? decoded.sub : null;
  } catch {
    return null;
  }
}
