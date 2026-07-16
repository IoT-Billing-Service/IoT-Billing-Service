/**
 * Unit tests — OAuth2 Service (Issue #57)
 *
 * Tests every pure/injectable unit in isolation using in-memory fakes for
 * Prisma. No real DB or Redis required — these run in < 1s with `vitest run`.
 *
 * Coverage:
 *   • Crypto helpers (sha256Hex, generateBearerToken, generateAuthCode,
 *     timingSafeEqual, computeS256Challenge)
 *   • Scope helpers (validateScopes, normaliseScopes)
 *   • OAuth2Service.authorise()
 *   • OAuth2Service.exchangeCode()
 *   • OAuth2Service.refreshTokens()
 *   • OAuth2Service.revokeToken()
 *   • OAuth2Service.introspect()
 *   • OAuth2Error shape and HTTP status mapping
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  sha256Hex,
  generateBearerToken,
  generateAuthCode,
  timingSafeEqual,
  computeS256Challenge,
  OAuth2Service,
  OAuth2Error,
} from '../../src/api/oauth2/oauth2_service.js';
import { validateScopes, normaliseScopes, ALL_SCOPES } from '../../src/api/oauth2/scopes.js';

// ---------------------------------------------------------------------------
// Minimal Prisma fake
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function makePrismaFake() {
  const clients: Row[] = [];
  const authCodes: Row[] = [];
  const tokens: Row[] = [];

  let idSeq = 1;
  const nextId = () => String(idSeq++);

  return {
    oAuth2Client: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
        clients.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: Row }) => {
        return clients.find((c) => c['id'] === where['id']) ?? null;
      },
    },
    oAuth2AuthCode: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId(), createdAt: new Date(), ...data };
        authCodes.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: Row }) => {
        return authCodes.find((c) => c['codeHash'] === where['codeHash']) ?? null;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const idx = authCodes.findIndex((c) => c['codeHash'] === where['codeHash']);
        if (idx === -1) throw new Error('Not found');
        authCodes[idx] = { ...authCodes[idx], ...data };
        return authCodes[idx];
      },
    },
    oAuth2Token: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId(), createdAt: new Date(), revokedAt: null, ...data };
        tokens.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: Row }) => {
        return tokens.find((t) => t['tokenHash'] === where['tokenHash']) ?? null;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const idx = tokens.findIndex((t) => t['tokenHash'] === where['tokenHash']);
        if (idx === -1) throw new Error('Not found');
        tokens[idx] = { ...tokens[idx], ...data };
        return tokens[idx];
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i]!;
          const matches = Object.entries(where).every(([k, v]) => {
            if (v === null) return t[k] === null;
            return t[k] === v;
          });
          if (matches) {
            tokens[i] = { ...t, ...data };
            count++;
          }
        }
        return { count };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(makePrismaFake()),
    // Keep a reference to raw arrays for assertions in tests
    _clients: clients,
    _authCodes: authCodes,
    _tokens: tokens,
  };
}

// ---------------------------------------------------------------------------
// Helpers: build a PKCE pair
// ---------------------------------------------------------------------------

function makePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = computeS256Challenge(verifier);
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

describe('sha256Hex', () => {
  it('returns a 64-char lowercase hex string', () => {
    const h = sha256Hex('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(sha256Hex('test')).toBe(sha256Hex('test'));
  });

  it('differs for different inputs', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});

describe('generateBearerToken', () => {
  it('produces unique tokens each call', () => {
    const a = generateBearerToken('oat');
    const b = generateBearerToken('oat');
    expect(a).not.toBe(b);
  });

  it('uses the supplied prefix', () => {
    expect(generateBearerToken('oat')).toMatch(/^oat_/);
    expect(generateBearerToken('ort')).toMatch(/^ort_/);
  });

  it('contains 64 hex chars after the prefix', () => {
    const raw = generateBearerToken('oat').slice('oat_'.length);
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('generateAuthCode', () => {
  it('returns a 32-char hex string', () => {
    expect(generateAuthCode()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces unique codes each call', () => {
    expect(generateAuthCode()).not.toBe(generateAuthCode());
  });
});

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('hello', 'hello')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(timingSafeEqual('hello', 'world')).toBe(false);
  });

  it('returns false when lengths differ', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('returns false for empty vs non-empty', () => {
    expect(timingSafeEqual('', 'a')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('computeS256Challenge', () => {
  it('produces a base64url string', () => {
    const c = computeS256Challenge('my-verifier');
    // base64url: no +, /, = chars
    expect(c).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('is deterministic', () => {
    expect(computeS256Challenge('v')).toBe(computeS256Challenge('v'));
  });

  it('satisfies RFC 7636 round-trip', () => {
    const { verifier, challenge } = makePkce();
    expect(computeS256Challenge(verifier)).toBe(challenge);
  });
});

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

describe('validateScopes', () => {
  it('accepts known scopes within allowed set', () => {
    expect(validateScopes('billing:read', 'billing:read billing:write')).toBe(true);
  });

  it('rejects unknown scope tokens', () => {
    expect(validateScopes('billing:read unknown:scope', 'billing:read unknown:scope')).toBe(false);
  });

  it('rejects scopes not in allowed set', () => {
    expect(validateScopes('billing:write', 'billing:read')).toBe(false);
  });

  it('accepts empty string (no scopes requested)', () => {
    expect(validateScopes('', 'billing:read')).toBe(true);
  });

  it('ALL_SCOPES contains all expected values', () => {
    for (const scope of ['billing:read', 'billing:write', 'devices:read', 'analytics:read', 'account:read']) {
      expect(ALL_SCOPES.has(scope)).toBe(true);
    }
  });
});

describe('normaliseScopes', () => {
  it('deduplicates', () => {
    expect(normaliseScopes('billing:read billing:read')).toBe('billing:read');
  });

  it('sorts tokens alphabetically', () => {
    expect(normaliseScopes('billing:write billing:read')).toBe('billing:read billing:write');
  });

  it('drops unknown scopes silently', () => {
    expect(normaliseScopes('billing:read bogus:scope')).toBe('billing:read');
  });

  it('handles empty string', () => {
    expect(normaliseScopes('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// OAuth2Service
// ---------------------------------------------------------------------------

describe('OAuth2Service', () => {
  let prisma: ReturnType<typeof makePrismaFake>;
  let service: OAuth2Service;

  // Seed a standard test client before each test
  let clientId: string;
  const REDIRECT_URI = 'https://third-party.example.com/callback';

  beforeEach(async () => {
    prisma = makePrismaFake();
    // Cast through unknown — the fake satisfies the subset of PrismaClient we use
    service = new OAuth2Service(prisma as unknown as import('@prisma/client').PrismaClient);

    // Register a public test client
    const { client } = await service.registerClient({
      name: 'Test Client',
      redirectUris: [REDIRECT_URI],
      allowedScopes: 'billing:read billing:write devices:read',
      ownerWallet: 'GTEST',
      isPublic: true,
    });
    clientId = client.id;
  });

  // -------------------------------------------------------------------------
  // registerClient
  // -------------------------------------------------------------------------

  describe('registerClient', () => {
    it('creates a client row with normalised scopes', async () => {
      const { client } = await service.registerClient({
        name: 'My App',
        redirectUris: ['https://app.example.com/cb'],
        allowedScopes: 'billing:write billing:read billing:write',
        ownerWallet: 'GWALLET',
        isPublic: true,
      });
      expect(client.allowedScopes).toBe('billing:read billing:write');
    });

    it('returns rawSecret for confidential clients', async () => {
      const { rawSecret } = await service.registerClient({
        name: 'Confidential App',
        redirectUris: ['https://server.example.com/cb'],
        allowedScopes: 'billing:read',
        ownerWallet: 'GWALLET',
        isPublic: false,
      });
      expect(rawSecret).not.toBeNull();
      expect(rawSecret).toMatch(/^cs_[0-9a-f]{64}$/);
    });

    it('returns null rawSecret for public clients', async () => {
      const { rawSecret } = await service.registerClient({
        name: 'Public App',
        redirectUris: ['https://app.example.com/cb'],
        allowedScopes: 'billing:read',
        ownerWallet: 'GWALLET',
        isPublic: true,
      });
      expect(rawSecret).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // authorise
  // -------------------------------------------------------------------------

  describe('authorise', () => {
    it('issues an auth code and stores only the hash', async () => {
      const { verifier, challenge } = makePkce();
      const result = await service.authorise({
        clientId,
        redirectUri: REDIRECT_URI,
        scope: 'billing:read',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        walletAddress: 'GWALLET',
      });

      expect(result.code).toMatch(/^[0-9a-f]{32}$/);
      expect(result.redirectUri).toBe(REDIRECT_URI);

      // Verify only the hash was stored
      const storedHash = sha256Hex(result.code);
      const row = prisma._authCodes.find((r) => r['codeHash'] === storedHash);
      expect(row).toBeDefined();
      expect(row!['codeHash']).toBe(storedHash);
      // Raw code must NOT appear in storage
      expect(JSON.stringify(prisma._authCodes)).not.toContain(result.code);

      void verifier; // used in exchange tests below
    });

    it('rejects an unknown client', async () => {
      const { challenge } = makePkce();
      await expect(
        service.authorise({
          clientId: 'nonexistent',
          redirectUri: REDIRECT_URI,
          scope: 'billing:read',
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          walletAddress: 'GWALLET',
        }),
      ).rejects.toThrow(OAuth2Error);
    });

    it('rejects a redirect_uri not in the registered list', async () => {
      const { challenge } = makePkce();
      await expect(
        service.authorise({
          clientId,
          redirectUri: 'https://evil.example.com/steal',
          scope: 'billing:read',
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          walletAddress: 'GWALLET',
        }),
      ).rejects.toThrow(OAuth2Error);
    });

    it('rejects a scope not in the client allowlist', async () => {
      const { challenge } = makePkce();
      await expect(
        service.authorise({
          clientId,
          redirectUri: REDIRECT_URI,
          scope: 'account:read', // not in client's allowedScopes
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          walletAddress: 'GWALLET',
        }),
      ).rejects.toThrow(OAuth2Error);
    });

    it('rejects plain code_challenge_method', async () => {
      await expect(
        service.authorise({
          clientId,
          redirectUri: REDIRECT_URI,
          scope: 'billing:read',
          codeChallenge: 'abcdef',
          codeChallengeMethod: 'plain',
          walletAddress: 'GWALLET',
        }),
      ).rejects.toThrow(OAuth2Error);
    });

    it('rejects a malformed code_challenge (too short)', async () => {
      await expect(
        service.authorise({
          clientId,
          redirectUri: REDIRECT_URI,
          scope: 'billing:read',
          codeChallenge: 'tooshort',
          codeChallengeMethod: 'S256',
          walletAddress: 'GWALLET',
        }),
      ).rejects.toThrow(OAuth2Error);
    });
  });

  // -------------------------------------------------------------------------
  // exchangeCode
  // -------------------------------------------------------------------------

  describe('exchangeCode', () => {
    async function getCode(scope = 'billing:read') {
      const pkce = makePkce();
      const result = await service.authorise({
        clientId,
        redirectUri: REDIRECT_URI,
        scope,
        codeChallenge: pkce.challenge,
        codeChallengeMethod: 'S256',
        walletAddress: 'GWALLET',
      });
      return { code: result.code, verifier: pkce.verifier };
    }

    it('exchanges a valid code for a token pair', async () => {
      const { code, verifier } = await getCode();
      const tokens = await service.exchangeCode({
        clientId,
        code,
        redirectUri: REDIRECT_URI,
        codeVerifier: verifier,
      });

      expect(tokens.accessToken).toMatch(/^oat_[0-9a-f]{64}$/);
      expect(tokens.refreshToken).toMatch(/^ort_[0-9a-f]{64}$/);
      expect(tokens.tokenType).toBe('Bearer');
      expect(tokens.expiresIn).toBeGreaterThan(0);
      expect(tokens.scope).toBe('billing:read');
    });

    it('does not store the raw bearer token — only its SHA-256 hash', async () => {
      const { code, verifier } = await getCode();
      const tokens = await service.exchangeCode({
        clientId,
        code,
        redirectUri: REDIRECT_URI,
        codeVerifier: verifier,
      });

      const storedJson = JSON.stringify(prisma._tokens);
      expect(storedJson).not.toContain(tokens.accessToken);
      expect(storedJson).not.toContain(tokens.refreshToken);
      expect(storedJson).toContain(sha256Hex(tokens.accessToken));
      expect(storedJson).toContain(sha256Hex(tokens.refreshToken));
    });

    it('rejects replay of the same code (single-use)', async () => {
      const { code, verifier } = await getCode();
      await service.exchangeCode({ clientId, code, redirectUri: REDIRECT_URI, codeVerifier: verifier });

      await expect(
        service.exchangeCode({ clientId, code, redirectUri: REDIRECT_URI, codeVerifier: verifier }),
      ).rejects.toThrow(OAuth2Error);
    });

    it('rejects a wrong code_verifier (PKCE failure)', async () => {
      const { code } = await getCode();
      await expect(
        service.exchangeCode({
          clientId,
          code,
          redirectUri: REDIRECT_URI,
          codeVerifier: 'wrong-verifier-that-is-long-enough-to-pass-format-checks-abcdef',
        }),
      ).rejects.toThrow(OAuth2Error);
    });

    it('rejects redirect_uri mismatch', async () => {
      const { code, verifier } = await getCode();
      await expect(
        service.exchangeCode({
          clientId,
          code,
          redirectUri: 'https://other.example.com/cb',
          codeVerifier: verifier,
        }),
      ).rejects.toThrow(OAuth2Error);
    });

    it('rejects an expired code', async () => {
      const { code, verifier } = await getCode();
      // Manually expire the code
      const codeHash = sha256Hex(code);
      const row = prisma._authCodes.find((r) => r['codeHash'] === codeHash)!;
      row['expiresAt'] = new Date(Date.now() - 1000);

      await expect(
        service.exchangeCode({ clientId, code, redirectUri: REDIRECT_URI, codeVerifier: verifier }),
      ).rejects.toThrow(OAuth2Error);
    });

    it('rejects an unknown code', async () => {
      const { verifier } = makePkce();
      await expect(
        service.exchangeCode({
          clientId,
          code: 'deadbeefdeadbeefdeadbeefdeadbeef',
          redirectUri: REDIRECT_URI,
          codeVerifier: verifier,
        }),
      ).rejects.toThrow(OAuth2Error);
    });
  });

  // -------------------------------------------------------------------------
  // refreshTokens
  // -------------------------------------------------------------------------

  describe('refreshTokens', () => {
    async function getTokenPair() {
      const pkce = makePkce();
      const { code } = await service.authorise({
        clientId,
        redirectUri: REDIRECT_URI,
        scope: 'billing:read',
        codeChallenge: pkce.challenge,
        codeChallengeMethod: 'S256',
        walletAddress: 'GWALLET',
      });
      return service.exchangeCode({
        clientId,
        code,
        redirectUri: REDIRECT_URI,
        codeVerifier: pkce.verifier,
      });
    }

    it('issues a new token pair and rotates the refresh token', async () => {
      const original = await getTokenPair();
      const rotated = await service.refreshTokens({
        clientId,
        refreshToken: original.refreshToken,
      });

      expect(rotated.accessToken).not.toBe(original.accessToken);
      expect(rotated.refreshToken).not.toBe(original.refreshToken);
    });

    it('marks the old refresh token as revoked after rotation', async () => {
      const original = await getTokenPair();
      await service.refreshTokens({ clientId, refreshToken: original.refreshToken });

      const oldHash = sha256Hex(original.refreshToken);
      const oldRow = prisma._tokens.find((t) => t['tokenHash'] === oldHash)!;
      expect(oldRow['revokedAt']).not.toBeNull();
    });

    it('rejects a refresh token that has already been rotated (replay)', async () => {
      const original = await getTokenPair();
      await service.refreshTokens({ clientId, refreshToken: original.refreshToken });

      await expect(
        service.refreshTokens({ clientId, refreshToken: original.refreshToken }),
      ).rejects.toThrow(OAuth2Error);
    });

    it('rejects an unknown refresh token', async () => {
      await expect(
        service.refreshTokens({ clientId, refreshToken: 'ort_' + 'a'.repeat(64) }),
      ).rejects.toThrow(OAuth2Error);
    });

    it('rejects passing an access token where a refresh token is expected', async () => {
      const pair = await getTokenPair();
      await expect(
        service.refreshTokens({ clientId, refreshToken: pair.accessToken }),
      ).rejects.toThrow(OAuth2Error);
    });
  });

  // -------------------------------------------------------------------------
  // revokeToken
  // -------------------------------------------------------------------------

  describe('revokeToken', () => {
    async function getTokenPair() {
      const pkce = makePkce();
      const { code } = await service.authorise({
        clientId,
        redirectUri: REDIRECT_URI,
        scope: 'billing:read',
        codeChallenge: pkce.challenge,
        codeChallengeMethod: 'S256',
        walletAddress: 'GWALLET',
      });
      return service.exchangeCode({
        clientId,
        code,
        redirectUri: REDIRECT_URI,
        codeVerifier: pkce.verifier,
      });
    }

    it('sets revokedAt on the access token', async () => {
      const pair = await getTokenPair();
      await service.revokeToken({ token: pair.accessToken, clientId });

      const hash = sha256Hex(pair.accessToken);
      const row = prisma._tokens.find((t) => t['tokenHash'] === hash)!;
      expect(row['revokedAt']).not.toBeNull();
    });

    it('is idempotent — does not throw on already-revoked token', async () => {
      const pair = await getTokenPair();
      await service.revokeToken({ token: pair.accessToken, clientId });
      await expect(service.revokeToken({ token: pair.accessToken, clientId })).resolves.not.toThrow();
    });

    it('is silent for an unknown token (RFC 7009)', async () => {
      await expect(
        service.revokeToken({ token: 'oat_' + 'z'.repeat(64), clientId }),
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // introspect
  // -------------------------------------------------------------------------

  describe('introspect', () => {
    async function getAccessToken() {
      const pkce = makePkce();
      const { code } = await service.authorise({
        clientId,
        redirectUri: REDIRECT_URI,
        scope: 'billing:read',
        codeChallenge: pkce.challenge,
        codeChallengeMethod: 'S256',
        walletAddress: 'GWALLET',
      });
      const pair = await service.exchangeCode({
        clientId,
        code,
        redirectUri: REDIRECT_URI,
        codeVerifier: pkce.verifier,
      });
      return pair.accessToken;
    }

    it('returns active:true for a valid access token', async () => {
      const token = await getAccessToken();
      const result = await service.introspect(token);
      expect(result.active).toBe(true);
      expect(result.scope).toBe('billing:read');
      expect(result.clientId).toBe(clientId);
      expect(result.sub).toBe('GWALLET');
      expect(typeof result.exp).toBe('number');
    });

    it('returns active:false for an unknown token', async () => {
      const result = await service.introspect('oat_' + '0'.repeat(64));
      expect(result.active).toBe(false);
    });

    it('returns active:false for a revoked token', async () => {
      const token = await getAccessToken();
      await service.revokeToken({ token, clientId });
      const result = await service.introspect(token);
      expect(result.active).toBe(false);
    });

    it('returns active:false for an expired token', async () => {
      const token = await getAccessToken();
      const hash = sha256Hex(token);
      const row = prisma._tokens.find((t) => t['tokenHash'] === hash)!;
      row['expiresAt'] = new Date(Date.now() - 1000);

      const result = await service.introspect(token);
      expect(result.active).toBe(false);
    });

    it('returns active:false for a refresh token (not introspectable)', async () => {
      const pkce = makePkce();
      const { code } = await service.authorise({
        clientId,
        redirectUri: REDIRECT_URI,
        scope: 'billing:read',
        codeChallenge: pkce.challenge,
        codeChallengeMethod: 'S256',
        walletAddress: 'GWALLET',
      });
      const pair = await service.exchangeCode({
        clientId,
        code,
        redirectUri: REDIRECT_URI,
        codeVerifier: pkce.verifier,
      });
      const result = await service.introspect(pair.refreshToken);
      expect(result.active).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // OAuth2Error
  // -------------------------------------------------------------------------

  describe('OAuth2Error', () => {
    it('maps invalid_client to 401', () => {
      expect(new OAuth2Error('invalid_client', 'test').httpStatus).toBe(401);
    });

    it('maps access_denied to 403', () => {
      expect(new OAuth2Error('access_denied', 'test').httpStatus).toBe(403);
    });

    it('maps server_error to 500', () => {
      expect(new OAuth2Error('server_error', 'test').httpStatus).toBe(500);
    });

    it('maps other codes to 400', () => {
      expect(new OAuth2Error('invalid_request', 'test').httpStatus).toBe(400);
      expect(new OAuth2Error('invalid_grant', 'test').httpStatus).toBe(400);
      expect(new OAuth2Error('invalid_scope', 'test').httpStatus).toBe(400);
    });

    it('serialises to RFC 6749 §5.2 JSON shape', () => {
      const err = new OAuth2Error('invalid_grant', 'Code expired');
      expect(err.toJSON()).toEqual({
        error: 'invalid_grant',
        error_description: 'Code expired',
      });
    });

    it('is an instance of Error', () => {
      expect(new OAuth2Error('server_error', 'oops')).toBeInstanceOf(Error);
    });
  });
});
