import { describe, it, expect } from 'vitest';
import {
  fromSorobanInt,
  toSorobanInt,
  formatCurrency,
  formatCompact,
  compareBalances,
} from './currencyFormatter';

describe('fromSorobanInt', () => {
  it('converts raw Soroban integer to decimal string', () => {
    expect(fromSorobanInt('10000000')).toBe('1.0000000');
    expect(fromSorobanInt('15000000')).toBe('1.5000000');
  });

  it('handles zero', () => {
    expect(fromSorobanInt('0')).toBe('0.0000000');
  });

  it('handles custom decimals', () => {
    expect(fromSorobanInt('10000', 4)).toBe('1.0000');
  });
});

describe('toSorobanInt', () => {
  it('converts decimal string to Soroban integer', () => {
    expect(toSorobanInt('1.5')).toBe('15000000');
    expect(toSorobanInt('0.5')).toBe('5000000');
  });

  it('handles whole numbers', () => {
    expect(toSorobanInt('10')).toBe('100000000');
  });
});

describe('formatCurrency', () => {
  it('formats numbers with commas and decimals', () => {
    expect(formatCurrency('1234567.89')).toBe('1,234,567.89');
  });

  it('handles NaN gracefully', () => {
    expect(formatCurrency('abc')).toBe('0.00');
  });
});

describe('formatCompact', () => {
  it('formats small numbers normally', () => {
    expect(formatCompact('999')).toBe('999.00');
  });

  it('formats thousands with K suffix', () => {
    expect(formatCompact('1500')).toBe('1.5K');
  });

  it('formats millions with M suffix', () => {
    expect(formatCompact('2500000')).toBe('2.5M');
  });
});

describe('compareBalances', () => {
  it('returns positive when a > b', () => {
    expect(compareBalances('100', '50')).toBeGreaterThan(0);
  });

  it('returns negative when a < b', () => {
    expect(compareBalances('50', '100')).toBeLessThan(0);
  });

  it('returns zero when equal', () => {
    expect(compareBalances('100', '100')).toBe(0);
  });
});
