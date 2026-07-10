'use client';

import { useMemo, useState } from 'react';
import type { MetricStreamPoint } from '@/types';
import { LiveMetricsCanvas } from '@/components/dashboard/LiveMetricsCanvas';

interface MetricStreamPanelProps {
  fleetId: string | null;
}

const METRIC_NAMES = ['powerUsage', 'signalStrength', 'temperature', 'dataRate'] as const;
const METRIC_LABELS: Record<string, string> = {
  powerUsage: 'Power (W)',
  signalStrength: 'Signal (dBm)',
  temperature: 'Temperature (°C)',
  dataRate: 'Data Rate (kbps)',
};

/**
 * Generates deterministic mock metric stream points.
 */
function generateMockStream(fleetId: string): MetricStreamPoint[] {
  if (!fleetId) return [];
  const points: MetricStreamPoint[] = [];
  const now = Date.now();

  for (const metricName of METRIC_NAMES) {
    for (let i = 0; i < 60; i++) {
      const baseValue: Record<string, number> = {
        powerUsage: 50,
        signalStrength: -70,
        temperature: 35,
        dataRate: 500,
      };
      const variance: Record<string, number> = {
        powerUsage: 20,
        signalStrength: 15,
        temperature: 10,
        dataRate: 200,
      };
      const bv = baseValue[metricName] ?? 0;
      const vr = variance[metricName] ?? 10;

      points.push({
        timestamp: now - (59 - i) * 1000,
        fleetId,
        metricName,
        value: bv + (Math.sin(i * 0.3) * vr) + (Math.random() - 0.5) * (vr * 0.2),
        unit: '',
      });
    }
  }

  return points;
}

interface MetricsFrame {
  timestamp: number;
  values: Record<string, number>;
}

export function MetricStreamPanel({ fleetId }: MetricStreamPanelProps) {
  const [selectedMetrics, setSelectedMetrics] = useState<Set<string>>(
    new Set(['powerUsage', 'signalStrength']),
  );

  const stream = useMemo(() => {
    const raw = generateMockStream(fleetId ?? '');
    // Group by timestamp into frames for LiveMetricsCanvas
    const frameMap = new Map<number, MetricsFrame>();
    for (const p of raw) {
      const existing = frameMap.get(p.timestamp);
      if (existing) {
        existing.values[p.metricName] = p.value;
      } else {
        frameMap.set(p.timestamp, {
          timestamp: p.timestamp,
          values: { [p.metricName]: p.value },
        });
      }
    }
    return Array.from(frameMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  }, [fleetId]);

  const allMetricNames = useMemo(() => METRIC_NAMES as unknown as string[], []);
  const visibleMetrics = useMemo(
    () => allMetricNames.filter((m) => selectedMetrics.has(m)),
    [allMetricNames, selectedMetrics],
  );

  const toggleMetric = (name: string) => {
    setSelectedMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        if (next.size <= 1) return prev; // keep at least one
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  if (!fleetId) {
    return (
      <div className="flex items-center justify-center h-64 rounded-lg border border-dashed border-gray-700">
        <p className="text-sm text-gray-500">
          Select a fleet to view its metric streams.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Metric toggle chips */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-400">Metrics:</span>
        {allMetricNames.map((name) => (
          <button
            key={name}
            onClick={() => toggleMetric(name)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              selectedMetrics.has(name)
                ? 'bg-green-600/20 text-green-300 border border-green-500/40'
                : 'bg-gray-800 text-gray-400 border border-gray-700 hover:border-gray-600'
            }`}
          >
            {METRIC_LABELS[name] ?? name}
          </button>
        ))}
      </div>

      {/* Real-time canvas */}
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-300">Live Metric Stream</h3>
        <LiveMetricsCanvas
          stream={stream}
          metrics={visibleMetrics}
          height={280}
        />
      </div>

      {/* Tabular snapshot */}
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-300">Latest Values</h3>
        {stream.length === 0 ? (
          <p className="text-sm text-gray-500">No metric data available yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {visibleMetrics.map((metricName) => {
              const latestFrame = stream[stream.length - 1];
              const value = latestFrame?.values[metricName];
              return (
                <div
                  key={metricName}
                  className="rounded-lg border border-gray-800 bg-gray-950 p-3"
                >
                  <p className="text-xs text-gray-500">
                    {METRIC_LABELS[metricName] ?? metricName}
                  </p>
                  <p className="mt-1 font-mono text-lg font-bold text-white">
                    {value !== undefined ? value.toFixed(1) : '—'}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
