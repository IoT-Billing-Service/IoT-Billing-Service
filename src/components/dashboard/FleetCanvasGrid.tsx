'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import type { FleetView } from '@/types';
import type { PositionResult } from '@/workers/fleetPosition.worker';


interface FleetCanvasGridProps {
  fleets: FleetView[];
  cellSize?: number;
}

const MEMORY_LIMIT = 10 * 1024 * 1024; // 10MB

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

export function FleetCanvasGrid({ fleets, cellSize = 80 }: FleetCanvasGridProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);

  const [zoomLevel, setZoomLevel] = useState(1.0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [visibleCells, setVisibleCells] = useState<PositionResult[]>([]);
  const [viewportBounds, setViewportBounds] = useState({
    xMin: 0,
    yMin: 0,
    xMax: 1000,
    yMax: 1000,
  });

  // Memory estimation & check
  const memoryUsage = estimateGridMemory(fleets);
  const isMemoryExceeded = memoryUsage > MEMORY_LIMIT;
  const isAggregated = zoomLevel < 0.5 || isMemoryExceeded;

  // Aggregate fleets if in cluster/aggregate mode
  const displayData = useCallback((): DisplayFleet[] => {
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

  const activeFleets = displayData();
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

    // Resolve theme-aware status colours from CSS custom properties
    const style = getComputedStyle(canvas);
    const activeColor = style.getPropertyValue('--chart-active').trim() || '#5ec962';
    const warningColor = style.getPropertyValue('--chart-warning').trim() || '#fca50a';
    const criticalColor = style.getPropertyValue('--chart-critical').trim() || '#dd513a';

    // Group cells by status color to minimize fillStyle/strokeStyle context changes
    const cellsByColor: Record<
      string,
      { cell: PositionResult; fleet: DisplayFleet; isHovered: boolean }[]
    > = {
      [activeColor]: [],  // Active
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

      // Pass 1: Borders and main text fields (using bold 10px monospace)
      ctx.fillStyle = color;
      ctx.font = isAggregated ? 'bold 12px monospace' : 'bold 10px monospace';

      list.forEach(({ cell, fleet, isHovered }) => {
        ctx.lineWidth = isHovered ? 2 : 1;
        ctx.strokeRect(cell.x, cell.y, currentCellSize - 2, currentCellSize - 2);

        // Header name
        const textYOffset = isAggregated ? 18 : 14;
        const lineSpacing = isAggregated ? 16 : 14;

        ctx.fillText(fleet.name.slice(0, isAggregated ? 12 : 8), cell.x + 6, cell.y + textYOffset);

        // Count string
        const countText =
          isAggregated && fleet.fleetCount !== undefined
            ? `${fleet.fleetCount} fleets`
            : `${fleet.activeCount}/${fleet.deviceCount}`;

        ctx.fillText(countText, cell.x + 6, cell.y + textYOffset + lineSpacing);
      });

      // Pass 2: Secondary text fields (using 9px monospace to avoid canvas state font changes)
      ctx.font = isAggregated ? '11px monospace' : '9px monospace';
      list.forEach(({ cell, fleet }) => {
        const textYOffset = isAggregated ? 18 : 14;
        const lineSpacing = isAggregated ? 16 : 14;

        let subText = `${fleet.totalPowerOutput.toFixed(0)}W`;
        if (isAggregated) {
          subText = `${(fleet.totalPowerOutput / 1000).toFixed(1)}kW`;
        }

        ctx.fillText(subText, cell.x + 6, cell.y + textYOffset + lineSpacing * 2);

        if (isAggregated) {
          ctx.fillStyle = '#8b9bb4';
          ctx.fillText(
            `${fleet.activeCount}/${fleet.deviceCount} dev`,
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
  ]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Track mouse coordinates for hover state
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const col = Math.floor(x / currentCellSize);
    const row = Math.floor(y / currentCellSize);

    if (col >= 0 && col < cols && row >= 0 && row < rows) {
      const idx = row * cols + col;
      if (idx < activeFleets.length) {
        if (hoveredIndex !== idx) {
          setHoveredIndex(idx);
        }
        return;
      }
    }

    if (hoveredIndex !== null) {
      setHoveredIndex(null);
    }
  };

  const handleMouseLeave = () => {
    setHoveredIndex(null);
  };

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
          style={{ width, height, display: 'block' }}
          className="rounded-lg cursor-crosshair"
          aria-label={`Fleet grid with ${activeFleets.length} nodes`}
        />
      </div>
    </div>
  );
}
