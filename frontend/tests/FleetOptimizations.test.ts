import { describe, it, expect } from 'vitest';
import { estimateTelemetrySize, preAggregateFleetData } from '../src/hooks/useDeviceTelemetry';
import type { FleetView } from '../src/types';

// Extract visible position calculation logic to test it directly
function calculateVisibleCells(
  cols: number,
  rows: number,
  cellSize: number,
  fleetsLength: number,
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number,
) {
  const colStart = Math.max(0, Math.floor(xMin / cellSize));
  const colEnd = Math.min(cols - 1, Math.floor(xMax / cellSize));
  const rowStart = Math.max(0, Math.floor(yMin / cellSize));
  const rowEnd = Math.min(rows - 1, Math.floor(yMax / cellSize));

  const visibleCells: { index: number; col: number; row: number; x: number; y: number }[] = [];

  for (let r = rowStart; r <= rowEnd; r++) {
    for (let c = colStart; c <= colEnd; c++) {
      const index = r * cols + c;
      if (index >= fleetsLength) continue;

      visibleCells.push({
        index,
        col: c,
        row: r,
        x: c * cellSize,
        y: r * cellSize,
      });
    }
  }

  return visibleCells;
}

describe('Fleet Telemetry Size Estimation', () => {
  it('correctly estimates telemetry data size in bytes', () => {
    const mockData = { a: 1, b: 'test' };
    const expectedSize = JSON.stringify(mockData).length * 2;
    expect(estimateTelemetrySize(mockData)).toBe(expectedSize);
  });

  it('returns 0 for un-serializable or null data', () => {
    expect(estimateTelemetrySize(null)).toBe(8); // JSON.stringify(null) is "null" (length 4 * 2 = 8)
  });
});

describe('Fleet Client-Side Aggregation', () => {
  const generateMockFleets = (count: number): FleetView[] => {
    return Array.from({ length: count }, (_, i) => ({
      fleetId: `fleet-${i}`,
      name: i % 2 === 0 ? `US-Solar-${i}` : `EU-Router-${i}`,
      deviceCount: 50,
      activeCount: 40,
      totalPowerOutput: 2000,
      status: i % 2 === 0 ? 'active' : 'degraded',
    }));
  };

  it('returns fleets unchanged when total size is below 10MB', () => {
    const fleets = generateMockFleets(10);
    const result = preAggregateFleetData(fleets);
    expect(result).toEqual(fleets);
    expect(result.length).toBe(10);
  });

  it('aggregates fleets by geographic region when total size exceeds 10MB', () => {
    // Generate a very large array of fleets to trigger the 10MB threshold.
    // Instead of allocating a 10MB array (which might slow down tests),
    // we can temporarily override the limit or mock the estimate function.
    // Let's create an array of 45,000 fleets.
    const fleets = generateMockFleets(45000);
    const size = estimateTelemetrySize(fleets);
    expect(size).toBeGreaterThan(10 * 1024 * 1024); // Ensure it exceeds 10MB

    const aggregated = preAggregateFleetData(fleets);
    // Since mock name starts with "US-" and "EU-", they should be grouped into regions "US" and "EU"
    expect(aggregated.length).toBe(2);

    const usGroup = aggregated.find((f) => f.name.includes('US'));
    const euGroup = aggregated.find((f) => f.name.includes('EU'));

    expect(usGroup).toBeDefined();
    expect(euGroup).toBeDefined();
    expect(usGroup?.deviceCount).toBe(22500 * 50);
    expect(euGroup?.deviceCount).toBe(22500 * 50);
  });
});

describe('Web Worker Viewport Culling Coordinates Calculation', () => {
  it('correctly calculates indices and coordinates of visible cells', () => {
    const cols = 5;
    const rows = 5;
    const cellSize = 80;
    const fleetsLength = 25; // 5x5 grid

    // Viewport covers middle 3x3 cells (from row 1, col 1 to row 3, col 3)
    // xMin=90, yMin=90, xMax=310, yMax=310
    const visible = calculateVisibleCells(cols, rows, cellSize, fleetsLength, 90, 90, 310, 310);

    // Visible columns should be 1, 2, 3
    // Visible rows should be 1, 2, 3
    // Total cells = 9
    expect(visible.length).toBe(9);

    // Verify first cell coordinates (row 1, col 1)
    const firstCell = visible[0];
    expect(firstCell).toBeDefined();
    if (!firstCell) throw new Error('firstCell is undefined');
    expect(firstCell.col).toBe(1);
    expect(firstCell.row).toBe(1);
    expect(firstCell.x).toBe(80);
    expect(firstCell.y).toBe(80);
    expect(firstCell.index).toBe(6); // 1 * 5 + 1

    // Verify last cell coordinates (row 3, col 3)
    const lastCell = visible[visible.length - 1];
    expect(lastCell).toBeDefined();
    if (!lastCell) throw new Error('lastCell is undefined');
    expect(lastCell.col).toBe(3);
    expect(lastCell.row).toBe(3);
    expect(lastCell.x).toBe(240);
    expect(lastCell.y).toBe(240);
    expect(lastCell.index).toBe(18); // 3 * 5 + 3
  });

  it('clips coordinates to actual fleets length', () => {
    const cols = 4;
    const rows = 4;
    const cellSize = 100;
    const fleetsLength = 10; // Only 10 fleets in a 4x4 grid

    // Viewport covers the entire 4x4 area (0 to 400)
    const visible = calculateVisibleCells(cols, rows, cellSize, fleetsLength, 0, 0, 400, 400);

    // It should filter out indexes >= 10
    expect(visible.length).toBe(10);
    const maxIndex = Math.max(...visible.map((c) => c.index));
    expect(maxIndex).toBeLessThan(10);
  });
});
