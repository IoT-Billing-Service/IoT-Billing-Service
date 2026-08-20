import { describe, it, expect } from 'vitest';

describe('Simulation Math', () => {
  it('calculates percentiles correctly', () => {
    const latencies = Array.from({ length: 100 }, (_, i) => i + 1);

    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p90 = latencies[Math.floor(latencies.length * 0.9)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    expect(p50).toBe(51);
    expect(p90).toBe(91);
    expect(p99).toBe(100);
  });
});
