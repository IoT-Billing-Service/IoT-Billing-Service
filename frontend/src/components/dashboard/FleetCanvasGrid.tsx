'use client';

import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { useTheme } from '@/components/providers/ThemeProvider';
import { monoCharWidth, truncateToWidth } from '@/utils/canvasText';
import type { FleetView } from '@/types';
import type { PositionResult } from '@/workers/fleetPosition.worker';

interface FleetCanvasGridProps {
  fleets: FleetView[];
  cellSize?: number;
  /** Called when a cell is clicked (with the fleet) or the selection is cleared (null). */
  onSelectFleet?: (fleet: FleetView | null) => void;
}

const MEMORY_LIMIT = 10 * 1024 * 1024; // 10MB

/**
 * Map canvas-local coordinates to a fleet index, or null if the point misses a
 * cell. Pure + shared by hover and click so both resolve a position the same
 * way against the *current* grid geometry.
 */
export function hitTestCell(
  x: number,
  y: number,
  cellSize: number,
  cols: number,
  rows: number,
  count: number,
): number | null {
  if (cellSize <= 0) return null;
  const col = Math.floor(x / cellSize);
  const row = Math.floor(y / cellSize);
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  const idx = row * cols + col;
  return idx >= 0 && idx < count ? idx : null;
}

/**
 * Resolve the currently-selected fleet by its stable id against the latest
 * fleet list. Selecting by id (not array index) is what makes selection
 * stale-proof: when the list is replaced by a new batch, the detail panel
 * re-derives from current data — it shows the updated fleet, or clears if the
 * fleet is gone. There is no closure or index to drift out of sync.
 */
export function resolveSelectedFleet<T extends { fleetId: string }>(
  fleets: T[],
  selectedId: string | null,
): T | null {
  if (!selectedId) return null;
  return fleets.find((f) => f.fleetId === selectedId) ?? null;
}

function estimateGridMemory(fleets: FleetView[]): number {
  try {
    return JSON.stringify(fleets).length * 2;
  } catch {
    return fleets.length * 250;
  }
}

interface DisplayFleet extends FleetView {
  fleetCount?: number;
  region?: string;
}

function getFleetRegion(fleet: DisplayFleet): string {
  if (fleet.region) {
    return fleet.region;
  }
  const nameParts = fleet.name.split(/[-_ ]/);
  const firstPart = nameParts[0] ?? '';
  if (nameParts.length > 1 && firstPart.length >= 2 && firstPart.length <= 5) {
    return firstPart;
  }
  const regions: string[] = ['North America', 'Europe', 'Asia-Pacific', 'South America', 'Africa'];
  let hash = 0;
  for (let i = 0; i < fleet.fleetId.length; i++) {
    hash = fleet.fleetId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return regions[Math.abs(hash) % regions.length] ?? 'Unknown';
}

export function FleetCanvasGrid({ fleets, cellSize = 80, onSelectFleet }: FleetCanvasGridProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);

  const { mode } = useTheme();

  const [zoomLevel, setZoomLevel] = useState(1.0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  // Selection is keyed by stable fleetId (not array index) so it can never
  // point at the wrong fleet after the list updates — see resolveSelectedFleet.
  const [selectedFleetId, setSelectedFleetId] = useState<string | null>(null);
  const [visibleCells, setVisibleCells] = useState<PositionResult[]>([]);
  const [viewportBounds, setViewportBounds] = useState({
    xMin: 0,
    yMin: 0,
    xMax: 1000,
    yMax: 1000,
  });

  // Theme-aware status colours, cached and only re-resolved from CSS custom
  // properties when the theme changes — not on every canvas redraw, since
  // getComputedStyle forces a style recalc that is wasteful in the draw loop.
  const themeColorsRef = useRef({
    active: '#5ec962',
    warning: '#fca50a',
    critical: '#dd513a',
  });
  const resolvedModeRef = useRef<string | null>(null);

  // Memory estimation & check — JSON.stringify of the full fleet array is
  // expensive, so only recompute when the fleets reference changes.
  const memoryUsage = useMemo(() => estimateGridMemory(fleets), [fleets]);
  const isMemoryExceeded = memoryUsage > MEMORY_LIMIT;
  const isAggregated = zoomLevel < 0.5 || isMemoryExceeded;

  // Aggregate fleets if in cluster/aggregate mode
  const activeFleets = useMemo<DisplayFleet[]>(() => {
    if (!isAggregated) {
      return fleets;
    }

    const regionsMap = new Map<
      string,
      {
        fleetCount: number;
        deviceCount: number;
        activeCount: number;
        totalPowerOutput: number;
        activeFleets: number;
        degradedFleets: number;
        inactiveFleets: number;
      }
    >();

    fleets.forEach((fleet) => {
      const region = getFleetRegion(fleet);
      let agg = regionsMap.get(region);
      if (!agg) {
        agg = {
          fleetCount: 0,
          deviceCount: 0,
          activeCount: 0,
          totalPowerOutput: 0,
          activeFleets: 0,
          degradedFleets: 0,
          inactiveFleets: 0,
        };
        regionsMap.set(region, agg);
      }
      agg.fleetCount++;
      agg.deviceCount += fleet.deviceCount;
      agg.activeCount += fleet.activeCount;
      agg.totalPowerOutput += fleet.totalPowerOutput;
      if (fleet.status === 'active') agg.activeFleets++;
      else if (fleet.status === 'degraded') agg.degradedFleets++;
      else agg.inactiveFleets++;
    });

    return Array.from(regionsMap.entries()).map(([region, agg]) => {
      let status: 'active' | 'degraded' | 'inactive' = 'inactive';
      if (agg.activeFleets > 0) status = 'active';
      else if (agg.degradedFleets > 0) status = 'degraded';

      const regionFleet: DisplayFleet = {
        fleetId: `region-${region.toLowerCase().replace(/\s+/g, '-')}`,
        name: region,
        deviceCount: agg.deviceCount,
        activeCount: agg.activeCount,
        totalPowerOutput: agg.totalPowerOutput,
        status,
        fleetCount: agg.fleetCount,
      };
      return regionFleet;
    });
  }, [fleets, isAggregated]);

  const currentCellSize = isAggregated ? cellSize * 1.5 : cellSize * zoomLevel;

  const cols = Math.ceil(Math.sqrt(activeFleets.length)) || 1;
  const rows = Math.ceil(activeFleets.length / cols) || 1;
  const width = cols * currentCellSize;
  const height = rows * currentCellSize;

  // Initialize Web Worker
  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      workerRef.current = new Worker(
        new URL('../../workers/fleetPosition.worker.ts', import.meta.url),
        { type: 'module' },
      );

      workerRef.current.onmessage = (e: MessageEvent<PositionResult[]>) => {
        setVisibleCells(e.data);
      };
    } catch (err) {
      console.error('Failed to initialize Web Worker for FleetCanvasGrid:', err);
    }

    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  // Compute viewport bounds and post to worker
  const updateViewport = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const canvasRect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    const xMin = Math.max(0, containerRect.left - canvasRect.left);
    const yMin = Math.max(0, containerRect.top - canvasRect.top);
    const xMax = Math.min(canvasRect.width, containerRect.right - canvasRect.left);
    const yMax = Math.min(canvasRect.height, containerRect.bottom - canvasRect.top);

    setViewportBounds({ xMin, yMin, xMax, yMax });

    if (workerRef.current) {
      workerRef.current.postMessage({
        cols,
        rows,
        cellSize: currentCellSize,
        fleetsLength: activeFleets.length,
        xMin,
        yMin,
        xMax,
        yMax,
      });
    } else {
      // Synchronous fallback if worker fails to load
      const colStart = Math.max(0, Math.floor(xMin / currentCellSize));
      const colEnd = Math.min(cols - 1, Math.floor(xMax / currentCellSize));
      const rowStart = Math.max(0, Math.floor(yMin / currentCellSize));
      const rowEnd = Math.min(rows - 1, Math.floor(yMax / currentCellSize));

      const fallbackCells: PositionResult[] = [];
      for (let r = rowStart; r <= rowEnd; r++) {
        for (let c = colStart; c <= colEnd; c++) {
          const index = r * cols + c;
          if (index >= activeFleets.length) continue;
          fallbackCells.push({
            index,
            col: c,
            row: r,
            x: c * currentCellSize,
            y: r * currentCellSize,
          });
        }
      }
      setVisibleCells(fallbackCells);
    }
  }, [cols, rows, currentCellSize, activeFleets.length]);

  // Handle scroll / resize to update viewport bounds
  useEffect(() => {
    updateViewport();

    // Capture events on window to detect scrolling of any parent container
    window.addEventListener('scroll', updateViewport, { capture: true, passive: true });
    window.addEventListener('resize', updateViewport, { passive: true });

    return () => {
      window.removeEventListener('scroll', updateViewport, { capture: true });
      window.removeEventListener('resize', updateViewport);
    };
  }, [updateViewport]);

  // Main Canvas Draw Loop
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    // Set device pixel ratio and sizes once per frame
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.resetTransform();
    ctx.scale(dpr, dpr);

    const { xMin, yMin, xMax, yMax } = viewportBounds;

    // Clear and draw single background covering only the viewport
    ctx.clearRect(xMin, yMin, xMax - xMin, yMax - yMin);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(xMin, yMin, xMax - xMin, yMax - yMin);

    // Re-resolve theme-aware status colours only when the theme has changed,
    // keeping getComputedStyle out of the steady-state per-frame draw path.
    if (resolvedModeRef.current !== mode) {
      const style = getComputedStyle(canvas);
      themeColorsRef.current = {
        active: style.getPropertyValue('--chart-active').trim() || '#5ec962',
        warning: style.getPropertyValue('--chart-warning').trim() || '#fca50a',
        critical: style.getPropertyValue('--chart-critical').trim() || '#dd513a',
      };
      resolvedModeRef.current = mode;
    }
    const activeColor = themeColorsRef.current.active;
    const warningColor = themeColorsRef.current.warning;
    const criticalColor = themeColorsRef.current.critical;

    // Group cells by status color to minimize fillStyle/strokeStyle context changes
    const cellsByColor: Record<
      string,
      { cell: PositionResult; fleet: DisplayFleet; isHovered: boolean }[]
    > = {
      [activeColor]: [], // Active
      [warningColor]: [], // Degraded
      [criticalColor]: [], // Inactive
    };

    visibleCells.forEach((cell) => {
      const fleet = activeFleets[cell.index];
      if (!fleet) return;

      const isHovered = cell.index === hoveredIndex;

      // Draw highlighted/active background if needed
      if (isHovered) {
        ctx.fillStyle = '#252542';
        ctx.fillRect(cell.x, cell.y, currentCellSize - 2, currentCellSize - 2);
      } else if (fleet.status === 'active' || fleet.status === 'degraded') {
        ctx.fillStyle = '#1e1e38';
        ctx.fillRect(cell.x, cell.y, currentCellSize - 2, currentCellSize - 2);
      }

      const statusColor =
        fleet.status === 'active'
          ? activeColor
          : fleet.status === 'degraded'
            ? warningColor
            : criticalColor;

      if (!cellsByColor[statusColor]) {
        cellsByColor[statusColor] = [];
      }
      cellsByColor[statusColor].push({ cell, fleet, isHovered });
    });

    // Render grouped colors sequentially
    Object.entries(cellsByColor).forEach(([color, list]) => {
      if (list.length === 0) return;

      ctx.strokeStyle = color;

      // Available text width inside a cell: from the 6px left inset to the
      // cell's right border, minus a small right inset. Labels are clipped to
      // this so they never overflow into the adjacent cell (issue #71).
      const maxTextWidth = Math.max(0, currentCellSize - 12);

      // Pass 1: Borders and main text fields (using bold 10px monospace)
      ctx.fillStyle = color;
      ctx.font = isAggregated ? 'bold 12px monospace' : 'bold 10px monospace';
      // Monospace glyphs share one advance width: measure once per font, then
      // truncation is exact integer arithmetic (no per-label measureText).
      const headCharWidth = monoCharWidth(ctx);

      list.forEach(({ cell, fleet, isHovered }) => {
        ctx.lineWidth = isHovered ? 2 : 1;
        ctx.strokeRect(cell.x, cell.y, currentCellSize - 2, currentCellSize - 2);

        // Header name
        const textYOffset = isAggregated ? 18 : 14;
        const lineSpacing = isAggregated ? 16 : 14;

        ctx.fillText(
          truncateToWidth(fleet.name, maxTextWidth, headCharWidth),
          cell.x + 6,
          cell.y + textYOffset,
        );

        // Count string
        const countText =
          isAggregated && fleet.fleetCount !== undefined
            ? `${fleet.fleetCount} fleets`
            : `${fleet.activeCount}/${fleet.deviceCount}`;

        ctx.fillText(
          truncateToWidth(countText, maxTextWidth, headCharWidth),
          cell.x + 6,
          cell.y + textYOffset + lineSpacing,
        );
      });

      // Pass 2: Secondary text fields (using 9px monospace to avoid canvas state font changes)
      ctx.font = isAggregated ? '11px monospace' : '9px monospace';
      const subCharWidth = monoCharWidth(ctx);
      list.forEach(({ cell, fleet }) => {
        const textYOffset = isAggregated ? 18 : 14;
        const lineSpacing = isAggregated ? 16 : 14;

        let subText = `${fleet.totalPowerOutput.toFixed(0)}W`;
        if (isAggregated) {
          subText = `${(fleet.totalPowerOutput / 1000).toFixed(1)}kW`;
        }

        ctx.fillText(
          truncateToWidth(subText, maxTextWidth, subCharWidth),
          cell.x + 6,
          cell.y + textYOffset + lineSpacing * 2,
        );

        if (isAggregated) {
          ctx.fillStyle = '#8b9bb4';
          ctx.fillText(
            truncateToWidth(
              `${fleet.activeCount}/${fleet.deviceCount} dev`,
              maxTextWidth,
              subCharWidth,
            ),
            cell.x + 6,
            cell.y + textYOffset + lineSpacing * 3,
          );
          ctx.fillStyle = color; // Restore color
        }
      });
    });
  }, [
    visibleCells,
    activeFleets,
    currentCellSize,
    hoveredIndex,
    width,
    height,
    viewportBounds,
    isAggregated,
    mode,
  ]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Resolve the fleet index under a pointer event using the shared hit-test.
  const fleetIndexAt = (e: React.MouseEvent<HTMLCanvasElement>): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return hitTestCell(
      e.clientX - rect.left,
      e.clientY - rect.top,
      currentCellSize,
      cols,
      rows,
      activeFleets.length,
    );
  };

  // Track mouse coordinates for hover state
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setHoveredIndex(fleetIndexAt(e));
  };

  const handleMouseLeave = () => {
    setHoveredIndex(null);
  };

  // Select the clicked fleet by its stable id (or clear on a miss). The detail
  // panel derives from current data via resolveSelectedFleet, so the selection
  // stays correct across data updates.
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const idx = fleetIndexAt(e);
    const fleet = idx !== null ? (activeFleets[idx] ?? null) : null;
    setSelectedFleetId(fleet ? fleet.fleetId : null);
    onSelectFleet?.(fleet);
  };

  const clearSelection = () => {
    setSelectedFleetId(null);
    onSelectFleet?.(null);
  };

  const selectedFleet = resolveSelectedFleet(activeFleets, selectedFleetId);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey) {
      e.preventDefault();
      // Zoom factor calculation
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      setZoomLevel((prev) => Math.min(2.0, Math.max(0.2, prev * zoomFactor)));
    }
  };

  return (
    <div className="w-full flex flex-col select-none">
      {/* Premium Design Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4 bg-gray-900 border border-gray-800 p-3 rounded-lg text-sm text-gray-300">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-100">Fleet Operations Grid</span>
          <span className="text-gray-500 font-mono text-xs">({fleets.length} total)</span>
          {isAggregated && (
            <span className="px-2 py-0.5 text-xs font-semibold bg-indigo-500/20 text-indigo-400 rounded-full border border-indigo-500/30">
              {isMemoryExceeded ? 'Aggregated: Mem Limit' : 'Aggregated: Zoom Out'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setZoomLevel((prev) => Math.max(0.2, prev - 0.1))}
              className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 active:bg-gray-600 text-white rounded transition font-bold"
              title="Zoom Out"
            >
              -
            </button>
            <span className="w-12 text-center font-mono font-bold text-gray-200">
              {(zoomLevel * 100).toFixed(0)}%
            </span>
            <button
              onClick={() => setZoomLevel((prev) => Math.min(2.0, prev + 0.1))}
              className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 active:bg-gray-600 text-white rounded transition font-bold"
              title="Zoom In"
            >
              +
            </button>
            <button
              onClick={() => setZoomLevel(1.0)}
              className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 active:bg-gray-600 text-white rounded transition text-xs"
              title="Reset Zoom"
            >
              Reset
            </button>
          </div>
          <div className="text-xs text-gray-500 hidden md:block">
            Use <kbd className="bg-gray-800 px-1 rounded text-gray-300">Ctrl + Scroll</kbd> to zoom
            in/out
          </div>
        </div>
      </div>

      {/* Grid Canvas Wrapper */}
      <div
        ref={containerRef}
        className="w-full overflow-auto max-h-[600px] border border-gray-800 bg-gray-950 rounded-lg relative scrollbar-thin scrollbar-thumb-gray-800 scrollbar-track-gray-950"
        onWheel={handleWheel}
        style={{ scrollBehavior: 'smooth' }}
      >
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
          style={{ width, height, display: 'block' }}
          className="rounded-lg cursor-pointer"
          aria-label={`Fleet grid with ${activeFleets.length} nodes`}
        />
      </div>

      {/* Selected fleet detail — derived from current data by id, so it never
          shows a stale fleet after the list updates. */}
      {selectedFleet && (
        <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-gray-100">{selectedFleet.name}</h4>
            <button
              onClick={clearSelection}
              className="text-xs text-gray-500 hover:text-gray-300"
              title="Clear selection"
            >
              Clear
            </button>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-gray-400">
            <div className="flex justify-between">
              <dt>Status</dt>
              <dd className="text-gray-200">{selectedFleet.status}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Devices</dt>
              <dd className="text-gray-200">
                {selectedFleet.activeCount}/{selectedFleet.deviceCount}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>Power</dt>
              <dd className="text-gray-200">{selectedFleet.totalPowerOutput.toFixed(0)} W</dd>
            </div>
            <div className="flex justify-between">
              <dt>Fleet ID</dt>
              <dd className="font-mono text-xs text-gray-300">{selectedFleet.fleetId}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
