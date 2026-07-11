'use client';

import { useMemo, useState } from 'react';
import type { IngestionFailure } from '@/types';

interface IngestionFailureTrackerProps {
  fleetId: string | null;
}

/**
 * Generates deterministic mock ingestion failures.
 * In production these come from a fleet-ingestion-logs API.
 */
function generateMockFailures(fleetId: string | null): IngestionFailure[] {
  if (!fleetId) return [];
  const failures: IngestionFailure[] = [];
  const errorCodes = [
    'TIMEOUT',
    'PARSE_ERROR',
    'CONNECTION_RESET',
    'BUFFER_OVERFLOW',
    'AUTH_EXPIRED',
  ];
  const baseTime = Date.now() - 3600_000; // last hour

  const count = fleetId === 'fleet-delta' ? 12 : 4;

  for (let i = 0; i < count; i++) {
    const resolved = i < count / 2;
    failures.push({
      id: `fail-${fleetId}-${i}`,
      fleetId,
      deviceId: `${fleetId}-dev-${(i * 7) % 20}`,
      failedAt: baseTime - i * 120_000,
      errorCode: errorCodes[i % errorCodes.length] ?? 'UNKNOWN',
      errorMessage: `Device stream interrupted: ${errorCodes[i % errorCodes.length] ?? 'UNKNOWN'}`,
      retryCount: resolved ? 2 : Math.floor(Math.random() * 4),
      resolved,
      resolvedAt: resolved ? baseTime - i * 120_000 + 30_000 : undefined,
    });
  }
  return failures;
}

export function IngestionFailureTracker({ fleetId }: IngestionFailureTrackerProps) {
  const [showResolved, setShowResolved] = useState(false);

  const failures = useMemo(() => generateMockFailures(fleetId), [fleetId]);
  const filtered = useMemo(
    () => (showResolved ? failures : failures.filter((f) => !f.resolved)),
    [failures, showResolved],
  );

  const unresolvedCount = failures.filter((f) => !f.resolved).length;

  if (!fleetId) {
    return (
      <div className="flex items-center justify-center h-64 rounded-lg border border-dashed border-gray-700">
        <p className="text-sm text-gray-500">Select a fleet to view ingestion failure logs.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary + filter bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-400">
            <span className="font-semibold text-red-400">{unresolvedCount}</span> unresolved
          </span>
          <span className="text-gray-600">/</span>
          <span className="text-gray-500">{failures.length} total</span>
        </div>
        <button
          onClick={() => setShowResolved(!showResolved)}
          className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
            showResolved
              ? 'bg-gray-700 text-gray-200'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
        >
          {showResolved ? 'Hide resolved' : 'Show resolved'}
        </button>
      </div>

      {/* Failure list */}
      {filtered.length === 0 ? (
        <div className="flex items-center justify-center h-48 rounded-lg border border-dashed border-gray-700">
          <div className="text-center">
            <p className="text-sm text-green-400">No ingestion failures</p>
            <p className="mt-1 text-xs text-gray-500">
              All data streams are operating normally for this fleet.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((failure) => (
            <div
              key={failure.id}
              className={`rounded-lg border p-4 text-sm transition-colors ${
                failure.resolved
                  ? 'border-gray-700 bg-gray-900/50'
                  : 'border-red-900/50 bg-red-950/10'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      failure.resolved ? 'bg-gray-500' : 'bg-red-400 animate-pulse'
                    }`}
                  />
                  <div>
                    <span className="font-mono text-xs font-medium text-gray-300">
                      {failure.errorCode}
                    </span>
                    <span className="ml-2 text-xs text-gray-500">{failure.deviceId}</span>
                  </div>
                </div>
                <span className="text-[10px] text-gray-600">
                  {new Date(failure.failedAt).toLocaleTimeString()}
                </span>
              </div>

              <p className="mt-2 text-xs text-gray-400">{failure.errorMessage}</p>

              <div className="mt-2 flex items-center gap-4 text-[10px]">
                <span className="text-gray-600">
                  Retries: <span className="text-gray-400">{failure.retryCount}</span>
                </span>
                {failure.resolved && failure.resolvedAt && (
                  <span className="text-green-600">
                    Resolved at {new Date(failure.resolvedAt).toLocaleTimeString()}
                  </span>
                )}
                {!failure.resolved && <span className="text-red-500">Auto-recovery pending</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
