import { describe, it, expect } from 'vitest';
import { computeAccessTokenTtlSeconds } from '../../../src/api/auth/session.js';

// Load model for issue #59.
//
// Before jitter, every device that authenticated in the same instant received a
// token with an identical TTL, so they all expired together and reconnected as a
// single thundering herd (100k / 15min ~= 6,667 reconnects/min, far above the
// ~500 req/s/replica auth budget). Jittered expiry spreads those reconnections
// across the jitter window. This test reproduces the fleet at scale and asserts
// the per-second reconnection peak stays well under the 200 req/s ceiling.

const KEEPALIVE_INTERVAL_SECONDS = 60;
const BASE_TTL_SECONDS = 1260;
const JITTER_SECONDS = 120;
const DEVICE_COUNT = 10_000;
const RPS_CEILING = 200;

/** Deterministic mulberry32 PRNG so the staggering result is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bucket reconnection events (one per device, at its token expiry) per second. */
function peakReconnectsPerSecond(ttls: number[]): number {
  const perSecond = new Map<number, number>();
  for (const ttl of ttls) {
    const bucket = Math.floor(ttl);
    perSecond.set(bucket, (perSecond.get(bucket) ?? 0) + 1);
  }
  return Math.max(...perSecond.values());
}

describe('jittered token expiry staggering (issue #59)', () => {
  it('keeps the access-token lifetime safely above the keepalive interval', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const ttl = computeAccessTokenTtlSeconds(BASE_TTL_SECONDS, JITTER_SECONDS, rng);
      // Invariant: token never expires within a keepalive window.
      expect(ttl).toBeGreaterThan(KEEPALIVE_INTERVAL_SECONDS);
      expect(ttl).toBeGreaterThanOrEqual(BASE_TTL_SECONDS);
      expect(ttl).toBeLessThanOrEqual(BASE_TTL_SECONDS + JITTER_SECONDS);
    }
  });

  it('holds reconnection RPS under 200 for 10,000 simultaneously-authenticated devices', () => {
    const rng = mulberry32(42);
    const ttls = Array.from({ length: DEVICE_COUNT }, () =>
      computeAccessTokenTtlSeconds(BASE_TTL_SECONDS, JITTER_SECONDS, rng),
    );

    const peak = peakReconnectsPerSecond(ttls);
    // ~10000 / 121 buckets ~= 83/s expected; comfortably under the ceiling.
    expect(peak).toBeLessThan(RPS_CEILING);
  });

  it('demonstrates the un-jittered baseline would stampede', () => {
    // jitter = 0 reproduces the old behaviour: one giant spike.
    const ttls = Array.from({ length: DEVICE_COUNT }, () =>
      computeAccessTokenTtlSeconds(BASE_TTL_SECONDS, 0),
    );
    expect(peakReconnectsPerSecond(ttls)).toBe(DEVICE_COUNT);
  });

  it('spreads expiry across the full jitter window', () => {
    const rng = mulberry32(7);
    const ttls = Array.from({ length: DEVICE_COUNT }, () =>
      computeAccessTokenTtlSeconds(BASE_TTL_SECONDS, JITTER_SECONDS, rng),
    );
    const distinctBuckets = new Set(ttls.map((t) => Math.floor(t)));
    // Expect close to JITTER_SECONDS + 1 distinct expiry seconds.
    expect(distinctBuckets.size).toBeGreaterThan(JITTER_SECONDS * 0.8);
  });
});
