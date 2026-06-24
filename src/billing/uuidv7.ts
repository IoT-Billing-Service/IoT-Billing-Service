import { randomBytes } from 'node:crypto';

/**
 * Minimal UUIDv7 generator (issue #42, idempotency keys).
 *
 * UUIDv7 (RFC 9562) is time-ordered: the high 48 bits are a Unix millisecond
 * timestamp, so keys generated over time sort lexicographically by creation
 * time — useful for the append-only `billing_finalization_log`. The remaining
 * bits are random, with the version (7) and variant (10xx) nibbles set per
 * spec. No external dependency (`uuid` is not in the tree).
 *
 * Layout (16 bytes):
 *   bytes 0..5   : 48-bit big-endian millisecond timestamp
 *   byte  6      : 0111xxxx  (version 7 in the high nibble)
 *   byte  8      : 10xxxxxx  (RFC 4122 variant in the top two bits)
 *   remaining    : random
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);

  // 48-bit timestamp, big-endian, into bytes 0..5.
  const ts = Math.max(0, Math.floor(nowMs));
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  // Version 7 in the high nibble of byte 6.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // RFC 4122 variant (10xx) in the top two bits of byte 8.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
