import { describe, it, expect } from 'vitest';
import { hitTestCell, resolveSelectedFleet } from './FleetCanvasGrid';

describe('hitTestCell', () => {
  // 3x3 grid of 80px cells, 9 fleets.
  const cell = 80;
  const cols = 3;
  const rows = 3;
  const count = 9;

  it('maps coordinates to the correct cell index', () => {
    expect(hitTestCell(10, 10, cell, cols, rows, count)).toBe(0); // col0,row0
    expect(hitTestCell(90, 10, cell, cols, rows, count)).toBe(1); // col1,row0
    expect(hitTestCell(10, 90, cell, cols, rows, count)).toBe(3); // col0,row1
    expect(hitTestCell(170, 170, cell, cols, rows, count)).toBe(8); // col2,row2
  });

  it('returns null for points outside the grid', () => {
    expect(hitTestCell(-5, 10, cell, cols, rows, count)).toBeNull(); // negative col
    expect(hitTestCell(10, -5, cell, cols, rows, count)).toBeNull(); // negative row
    expect(hitTestCell(240, 10, cell, cols, rows, count)).toBeNull(); // col 3 >= cols
    expect(hitTestCell(10, 240, cell, cols, rows, count)).toBeNull(); // row 3 >= rows
  });

  it('returns null for cells beyond the fleet count (sparse last row)', () => {
    // 3x3 geometry but only 5 fleets — the last 4 cells are empty.
    expect(hitTestCell(170, 170, cell, cols, rows, 5)).toBeNull(); // idx 8 >= 5
    expect(hitTestCell(90, 90, cell, cols, rows, 5)).toBe(4); // idx 4 < 5
  });

  it('returns null for a non-positive cell size', () => {
    expect(hitTestCell(10, 10, 0, cols, rows, count)).toBeNull();
    expect(hitTestCell(10, 10, -80, cols, rows, count)).toBeNull();
  });
});

describe('resolveSelectedFleet', () => {
  const v1 = [
    { fleetId: 'a', totalPowerOutput: 100 },
    { fleetId: 'b', totalPowerOutput: 200 },
  ];

  it('returns null when nothing is selected', () => {
    expect(resolveSelectedFleet(v1, null)).toBeNull();
  });

  it('resolves the selected fleet by id', () => {
    expect(resolveSelectedFleet(v1, 'b')).toBe(v1[1]);
  });

  it('is stale-proof: resolves against the LATEST list, not a captured one', () => {
    // The list is replaced by a new batch with updated data for the same id.
    const v2 = [
      { fleetId: 'a', totalPowerOutput: 999 },
      { fleetId: 'b', totalPowerOutput: 200 },
    ];
    const resolved = resolveSelectedFleet(v2, 'a');
    expect(resolved).toBe(v2[0]); // new object, not v1[0]
    expect(resolved?.totalPowerOutput).toBe(999); // current value, never stale
  });

  it('clears (returns null) when the selected fleet is gone after an update', () => {
    const v2 = [{ fleetId: 'b', totalPowerOutput: 200 }]; // 'a' removed
    expect(resolveSelectedFleet(v2, 'a')).toBeNull();
  });
});
