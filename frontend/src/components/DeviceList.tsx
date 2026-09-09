import { useEffect, useState } from 'react';
import { fetchBalance, fetchMetrics } from '../services/api';
import type { Balance, MetricSeries } from '../services/api';

const DEVICE_ID = 'D1';

export function DeviceList() {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [series, setSeries] = useState<MetricSeries[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchBalance(DEVICE_ID), fetchMetrics(DEVICE_ID)])
      .then(([b, s]) => {
        setBalance(b);
        setSeries(s);
      })
      .catch((e: unknown) => setError((e as Error).message));
  }, []);

  if (error) return <p>Error: {error}</p>;
  if (!balance) return <p>Loading…</p>;

  return (
    <section>
      <h1>Devices</h1>
      <ul>
        <li>
          <strong>{DEVICE_ID}</strong> — balance {balance.on_chain_balance} ·{' '}
          {balance.total_units} units · {balance.total_billed} billed
        </li>
      </ul>
      <table border={1} cellPadding={6}>
        <thead>
          <tr>
            <th>Bucket</th>
            <th>Units</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {series.map((s) => (
            <tr key={s.bucket}>
              <td>{s.bucket}</td>
              <td>{s.total_units}</td>
              <td>{s.total_cost}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
