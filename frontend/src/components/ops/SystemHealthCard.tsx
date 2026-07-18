'use client';

import { Activity, Cpu, Database, Wifi, AlertOctagon } from 'lucide-react';
import type { SystemHealthSnapshot } from './useDashboardData';

interface SystemHealthCardProps {
  health: SystemHealthSnapshot | undefined;
}

export function SystemHealthCard({ health }: SystemHealthCardProps) {
  if (health === undefined) {
    return (
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <Activity className="h-4 w-4 text-cyan-400" />
          System Health
        </h3>
        <div className="mt-4 flex items-center justify-center py-8">
          <span className="text-xs text-neutral-600">Loading system metrics...</span>
        </div>
      </div>
    );
  }

  const eventLoopHealthy = health.eventLoopLagMs < 100;
  const dbPoolHealthy = health.dbPool.total > 0;
  const ledgerHealthy = health.ledgerSync.lag < 10;
  const cbOpen = health.circuitBreaker.state === 2;

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
      <h3 className="text-sm font-semibold text-white flex items-center gap-2">
        <Activity className="h-4 w-4 text-cyan-400" />
        System Health
      </h3>

      {/* Health indicators */}
      <div className="mt-4 space-y-3">
        {/* Event Loop */}
        <HealthRow
          icon={<Cpu className="h-3.5 w-3.5" />}
          label="Event Loop Lag"
          value={`${health.eventLoopLagMs.toFixed(1)}ms`}
          healthy={eventLoopHealthy}
        />

        {/* GC Pauses */}
        <HealthRow
          icon={<Activity className="h-3.5 w-3.5" />}
          label="GC Pause (p99)"
          value={`${health.gcPause.p99.toFixed(0)}ms`}
          healthy={health.gcPause.p99 < 50}
        />

        {/* DB Pool */}
        <HealthRow
          icon={<Database className="h-3.5 w-3.5" />}
          label="DB Pool"
          value={`${health.dbPool.active}/${health.dbPool.total} active`}
          healthy={dbPoolHealthy}
        />

        {/* Ledger Sync */}
        <HealthRow
          icon={<Wifi className="h-3.5 w-3.5" />}
          label="Ledger Sync Lag"
          value={health.ledgerSync.lag === 0 ? 'In sync' : `${health.ledgerSync.lag} ledgers`}
          healthy={ledgerHealthy}
        />

        {/* Circuit Breaker */}
        {cbOpen && (
          <HealthRow
            icon={<AlertOctagon className="h-3.5 w-3.5" />}
            label="Circuit Breaker"
            value="OPEN"
            healthy={false}
          />
        )}
      </div>

      {/* DB Pool detail */}
      <div className="mt-4 rounded-md bg-neutral-800/50 p-3">
        <p className="text-[11px] text-neutral-500 mb-2">Database Pool</p>
        <div className="grid grid-cols-4 gap-2 text-center">
          <div>
            <p className="text-[10px] text-neutral-600">Total</p>
            <p className="text-xs font-mono font-bold text-white">{health.dbPool.total}</p>
          </div>
          <div>
            <p className="text-[10px] text-neutral-600">Active</p>
            <p className="text-xs font-mono font-bold text-green-400">{health.dbPool.active}</p>
          </div>
          <div>
            <p className="text-[10px] text-neutral-600">Idle</p>
            <p className="text-xs font-mono font-bold text-cyan-400">{health.dbPool.idle}</p>
          </div>
          <div>
            <p className="text-[10px] text-neutral-600">Waiting</p>
            <p className="text-xs font-mono font-bold text-amber-400">{health.dbPool.waiting}</p>
          </div>
        </div>
      </div>

      {/* Ledger detail */}
      <div className="mt-3 rounded-md bg-neutral-800/50 p-3">
        <p className="text-[11px] text-neutral-500 mb-2">Ledger Sync</p>
        <div className="grid grid-cols-2 gap-2 text-center">
          <div>
            <p className="text-[10px] text-neutral-600">Last Synced</p>
            <p className="text-xs font-mono font-bold text-white">
              {health.ledgerSync.lastSyncedSequence ?? '—'}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-neutral-600">Latest Polled</p>
            <p className="text-xs font-mono font-bold text-white">
              {health.ledgerSync.latestPolledSequence ?? '—'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function HealthRow({
  icon,
  label,
  value,
  healthy,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  healthy: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className={`${healthy ? 'text-green-400' : 'text-red-400'}`}>{icon}</span>
        <span className="text-xs text-neutral-400">{label}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${healthy ? 'bg-green-400' : 'bg-red-400 animate-pulse'}`}
        />
        <span className={`text-xs font-mono ${healthy ? 'text-neutral-300' : 'text-red-400'}`}>
          {value}
        </span>
      </div>
    </div>
  );
}
