import { describe, expect, it } from 'vitest';
import { fetchBalance } from './api';

describe('api service', () => {
  it('exports expected service functions', () => {
    expect(typeof fetchBalance).toBe('function');
  });
});
