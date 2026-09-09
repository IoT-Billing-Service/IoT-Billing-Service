import { useEffect, useState } from 'react';
import { fetchBalance, fetchDevices, fetchMetrics } from '../services/api';
import type { Balance, DeviceInfo, MetricSeries } from '../services/api';

export function DeviceList() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [balances, setBalances] = useState<Record<string, Balance | null>>({});
  const [series, setSeries] = useState<Record<string, MetricSeries[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    fetchDevices()
      .then(async (list) => {
        if (cancelled) return;
        setDevices(list);
        const [balMap, seriesMap] = await Promise.all([
          Promise.all(
            list.map((d) => fetchBalance(d.device_id).catch(() => null)),
          ),
          Promise.all(
            list.map((d) => fetchMetrics(d.device_id).catch(() => [])),
          ),
        ]);
        if (cancelled) return;
        setBalances(
          Object.fromEntries(list.map((d, i) => [d.device_id, balMap[i]])),
        );
        setSeries(
          Object.fromEntries(list.map((d, i) => [d.device_id, seriesMap[i]])),
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p>Error: {error}</p>;
  if (loading) return <p>Loading devices…</p>;
  if (devices.length === 0)
    return <p>No devices yet — start the emulator and register a device.</p>;

  return (
    <section>
      <h1>Devices ({devices.length})</h1>
      <table border={1} cellPadding={6}>
        <thead>
          <tr>
            <th>Device</th>
            <th>Balance</th>
            <th>Units</th>
            <th>Billed</th>
            <th>Latest seq</th>
            <th>Records</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => {
            const bal = balances[d.device_id];
            return (
              <tr key={d.device_id}>
                <td>
                  <strong>{d.device_id}</strong>
                </td>
                <td>{bal?.on_chain_balance ?? '—'}</td>
                <td>{Number(bal?.total_units ?? d.total_units)}</td>
                <td>{Number(bal?.total_billed ?? d.total_cost)}</td>
                <td>{bal?.latest_seq ?? '—'}</td>
                <td>{d.event_count}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {(series[devices[0].device_id] ?? []).length > 0 && (
        <table border={1} cellPadding={6}>
          <thead>
            <tr>
              <th>Bucket</th>
              <th>Units</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {series[devices[0].device_id].map((s) => (
              <tr key={s.bucket}>
                <td>{s.bucket}</td>
                <td>{s.total_units}</td>
                <td>{s.total_cost}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
