import { describe, it, expect } from 'vitest';
import { safeStringify, safeParse, mapSetReplacer, mapSetReviver, TYPE_TAG } from './serialization';

describe('the footgun this guards against', () => {
  it('plain JSON.stringify silently drops Map/Set data', () => {
    // This is exactly why the helpers exist: no error, just empty objects.
    // The no-restricted-syntax guardrail flags these on purpose — disabled here
    // because we are deliberately demonstrating the footgun.
    // eslint-disable-next-line no-restricted-syntax
    expect(JSON.stringify(new Map([['a', 1]]))).toBe('{}');
    // eslint-disable-next-line no-restricted-syntax
    expect(JSON.stringify(new Set([1, 2, 3]))).toBe('{}');
  });
});

describe('safeStringify / safeParse', () => {
  it('round-trips a Map without data loss', () => {
    const map = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const out = safeParse<Map<string, number>>(safeStringify(map));
    expect(out).toBeInstanceOf(Map);
    expect(out.get('a')).toBe(1);
    expect(out.get('b')).toBe(2);
    expect(out.size).toBe(2);
  });

  it('round-trips a Set without data loss', () => {
    const set = new Set([1, 2, 3]);
    const out = safeParse<Set<number>>(safeStringify(set));
    expect(out).toBeInstanceOf(Set);
    expect([...out]).toEqual([1, 2, 3]);
  });

  it('round-trips nested and mixed structures', () => {
    const input = {
      devices: new Map<string, { seen: Set<string> }>([
        ['dev-1', { seen: new Set(['ledger-1', 'ledger-2']) }],
      ]),
      tags: new Set(['active', 'critical']),
      count: 42,
      label: 'fleet',
    };

    const out = safeParse<typeof input>(safeStringify(input));

    expect(out.count).toBe(42);
    expect(out.label).toBe('fleet');
    expect(out.tags).toBeInstanceOf(Set);
    expect([...out.tags]).toEqual(['active', 'critical']);
    expect(out.devices).toBeInstanceOf(Map);
    const dev = out.devices.get('dev-1');
    expect(dev?.seen).toBeInstanceOf(Set);
    expect([...(dev?.seen ?? [])]).toEqual(['ledger-1', 'ledger-2']);
  });

  it('preserves Map entries with non-string keys', () => {
    const map = new Map<number, string>([
      [1, 'one'],
      [2, 'two'],
    ]);
    const out = safeParse<Map<number, string>>(safeStringify(map));
    expect(out.get(1)).toBe('one');
    expect(out.get(2)).toBe('two');
  });

  it('leaves plain JSON values untouched', () => {
    const input = { a: 1, b: [1, 2, { c: 'x' }], d: null, e: true };
    expect(safeParse(safeStringify(input))).toEqual(input);
  });
});

describe('mapSetReplacer / mapSetReviver', () => {
  it('encode Map/Set into tagged objects and back', () => {
    expect(mapSetReplacer('', new Map([['a', 1]]))).toEqual({
      [TYPE_TAG]: 'Map',
      value: [['a', 1]],
    });
    expect(mapSetReplacer('', new Set([1]))).toEqual({ [TYPE_TAG]: 'Set', value: [1] });

    const revivedMap = mapSetReviver('', { [TYPE_TAG]: 'Map', value: [['a', 1]] });
    expect(revivedMap).toBeInstanceOf(Map);

    const revivedSet = mapSetReviver('', { [TYPE_TAG]: 'Set', value: [1] });
    expect(revivedSet).toBeInstanceOf(Set);
  });

  it('pass through values that are not tagged collections', () => {
    expect(mapSetReplacer('', 5)).toBe(5);
    expect(mapSetReviver('', { type: 'Map' })).toEqual({ type: 'Map' });
    expect(mapSetReviver('', null)).toBe(null);
  });
});
