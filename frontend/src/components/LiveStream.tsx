import { useTelemetry } from '../hooks/useTelemetry';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useEffect, useState } from 'react';

interface Sample {
  t: string;
  cost: number;
}

export function LiveStream() {
  const event = useTelemetry();
  const [samples, setSamples] = useState<Sample[]>([]);

  useEffect(() => {
    if (event && event.type === 'meter_billed') {
      setSamples((prev) =>
        [
          ...prev,
          { t: new Date().toLocaleTimeString(), cost: Number(event.cost) },
        ].slice(-60),
      );
    }
  }, [event]);

  const last = event;

  return (
    <section>
      <h1>Live Telemetry</h1>
      {last ? (
        <p>
          Last event: device {last.device_id} · +{last.units} units · cost{' '}
          {String(last.cost)} · seq {String(last.seq)}
        </p>
      ) : (
        <p>Waiting for meter_billed events…</p>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={samples}>
          <XAxis dataKey="t" />
          <YAxis />
          <Tooltip />
          <Line type="monotone" dataKey="cost" stroke="#2563eb" />
        </LineChart>
      </ResponsiveContainer>
    </section>
  );
}
