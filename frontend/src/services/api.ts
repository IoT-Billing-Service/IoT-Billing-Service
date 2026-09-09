const API_URL = import.meta.env.VITE_API_URL ?? '/api';

export interface MetricSeries {
  bucket: string;
  total_units: number;
  total_cost: number;
  event_count: number;
}

export interface Balance {
  device_id: string;
  on_chain_balance: number | null;
  latest_seq: number;
  pending_uncommitted_units: number;
  total_units: number;
  total_billed: number;
}

export async function fetchMetrics(deviceId: string): Promise<MetricSeries[]> {
  const res = await fetch(`${API_URL}/devices/${deviceId}/metrics`);
  if (!res.ok) throw new Error(`fetchMetrics failed: ${res.status}`);
  const body = await res.json();
  return body.series ?? [];
}

export async function fetchBalance(deviceId: string): Promise<Balance> {
  const res = await fetch(`${API_URL}/devices/${deviceId}/balance`);
  if (!res.ok) throw new Error(`fetchBalance failed: ${res.status}`);
  return res.json();
}
