/**
 * serialization
 * ─────────────
 * Safe JSON round-tripping for `Map` and `Set`.
 *
 * Issue #70 described a (fictional) RSC serialization bug. The valid kernel
 * underneath it is real, though: `JSON.stringify` silently turns a `Map` or
 * `Set` into `{}` — they have no enumerable own properties and no `toJSON`, so
 * the data vanishes with no error. There is no such boundary in the codebase
 * today (workers and IndexedDB use structured clone, which preserves Map/Set;
 * no store persists one). These helpers exist so that the FIRST time a Map/Set
 * genuinely has to cross a JSON boundary — zustand `persist`, a JSON-based
 * worker message, an API payload — it can do so without data loss.
 *
 * Encoding: a `Map` becomes `{ [TYPE_TAG]: 'Map', value: [...entries] }` and a
 * `Set` becomes `{ [TYPE_TAG]: 'Set', value: [...values] }`. The replacer/
 * reviver recurse via JSON itself, so nested and deeply-mixed structures
 * round-trip correctly.
 */

/** Marker key identifying an encoded Map/Set. Distinctive to avoid colliding
 *  with real data keys. */
export const TYPE_TAG = '__serializedCollection';

interface TaggedCollection {
  [TYPE_TAG]: 'Map' | 'Set';
  value: unknown[];
}

function isTaggedCollection(value: unknown): value is TaggedCollection {
  if (value === null || typeof value !== 'object') return false;
  const tag = (value as Record<string, unknown>)[TYPE_TAG];
  return tag === 'Map' || tag === 'Set';
}

/**
 * `JSON.stringify` replacer that encodes `Map`/`Set` into tagged plain objects.
 * Nested collections are handled automatically because JSON.stringify applies
 * the replacer recursively to the encoded `value` array.
 */
export function mapSetReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return { [TYPE_TAG]: 'Map', value: Array.from(value.entries()) } satisfies TaggedCollection;
  }
  if (value instanceof Set) {
    return { [TYPE_TAG]: 'Set', value: Array.from(value.values()) } satisfies TaggedCollection;
  }
  return value;
}

/**
 * `JSON.parse` reviver that reconstructs `Map`/`Set` from tagged objects. The
 * reviver runs bottom-up, so nested collections are already revived by the time
 * their container is rebuilt.
 */
export function mapSetReviver(_key: string, value: unknown): unknown {
  if (isTaggedCollection(value)) {
    return value[TYPE_TAG] === 'Map'
      ? new Map(value.value as [unknown, unknown][])
      : new Set(value.value);
  }
  return value;
}

/** `JSON.stringify` that preserves `Map`/`Set`. Drop-in for the unsafe call. */
export function safeStringify(value: unknown, space?: number): string {
  return JSON.stringify(value, mapSetReplacer, space);
}

/** `JSON.parse` counterpart to {@link safeStringify}. */
export function safeParse<T = unknown>(text: string): T {
  return JSON.parse(text, mapSetReviver) as T;
}
