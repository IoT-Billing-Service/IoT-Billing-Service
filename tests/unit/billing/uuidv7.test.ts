import { describe, it, expect } from 'vitest';
import { uuidv7 } from '../../../src/billing/uuidv7.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('produces a canonical UUID string', () => {
    expect(uuidv7()).toMatch(UUID_RE);
  });

  it('sets the version nibble to 7 and the RFC 4122 variant', () => {
    const id = uuidv7();
    expect(id[14]).toBe('7'); // version nibble (start of 3rd group)
    expect(['8', '9', 'a', 'b']).toContain(id[19]); // variant nibble (start of 4th group)
  });

  it('encodes the timestamp in the high 48 bits (time-ordered)', () => {
    const earlier = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_001_000);
    const hex = (u: string): string => u.replace(/-/g, '').slice(0, 12);
    expect(hex(earlier) < hex(later)).toBe(true);
  });

  it('is collision-resistant within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(1_700_000_000_000)));
    expect(ids.size).toBe(1000);
  });
});
