'use client';

import { Radio, Zap } from 'lucide-react';
import type { SystemHealthSnapshot } from './useDashboardData';

interface IngestionHealthCardProps {
  health: SystemHealthSnapshot | undefined;
}

export function IngestionHealthCard({ health }: IngestionHealthCardProps) {
  const queueDepth = health?.ingestionQueueDepth ?? 0;
  const isHealthy = queueDepth < 1000;

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <Radio className="h-4 w-4 text-cyan-400" />
          Ingestion Pipeline
        </h3>
        <div
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 ${
            isHealthy
              ? 'border-green-800/30 bg-green-950/20'
              : 'border-amber-800/30 bg-amber-950/20'
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${isHealthy ? 'bg-green-400' : 'bg-amber-400 animate-pulse'}`}
          />
          <span
            className={`text-xs font-medium ${isHealthy ? 'text-green-400' : 'text-amber-400'}`}
          >
            {isHealthy ? 'Healthy' : 'Backpressure'}
          </span>
        </div>
      </div>

      {/* Ingestion metrics */}
      <div className="mt-4 grid grid-cols-3 gap-4">
        <div>
          <div className="flex items-center gap-1.5">
            <Zap className="h-3 w-3 text-amber-400" />
            <p className="text-[11px] text-neutral-500">Queue Depth</p>
          </div>
          <p className={`mt-1 text-lg font-bold font-mono ${isHealthy ? 'text-green-400' : 'text-amber-400'}`}>
            {queueDepth.toLocaleString()}
          </p>
        </div>
        <div>
          <div className="flex items-center gap-1.5">
            <Radio className="h-3 w-3 text-cyan-400" />
            <p className="text-[11px] text-neutral-500">Event Loop</p>
          </div>
          <p className="mt-1 text-lg font-bold font-mono text-white">
            {(health?.eventLoopLagMs ?? 0).toFixed(1)}ms
          </p>
        </div>
        <div>
          <div className="flex items-center gap-1.5">
            <Radio className="h-3 w-3 text-purple-400" />
            <p className="text-[11px] text-neutral-500">GC Pauses</p>
          </div>
          <p className="mt-1 text-lg font-bold font-mono text-white">
            {health?.gcPause.count ?? 0}
          </p>
        </div>
      </div>

      {/* Queue depth bar */}
      <div className="mt-4">
        <div className="flex justify-between text-[11px] text-neutral-500">
          <span>Queue Pressure</span>
          <span className="font-mono">
            {queueDepth < 100 ? 'Low' : queueDepth < 500 ? 'Medium' : queueDepth < 1000 ? 'High' : 'Critical'}
          </span>
        </div>
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              queueDepth < 100
                ? 'bg-green-500'
                : queueDepth < 500
                  ? 'bg-cyan-500'
                  : queueDepth < 1000
                    ? 'bg-amber-500'
                    : 'bg-red-500'
            }`}
            style={{ width: `${Math.min((queueDepth / 1000) * 100, 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
