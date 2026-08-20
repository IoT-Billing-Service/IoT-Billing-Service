import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '5s', target: 200 }, // Sudden burst
    { duration: '10s', target: 200 }, // Sustain burst
    { duration: '5s', target: 0 },   // Cool down
  ],
  thresholds: {
    http_req_duration: ['p(99)<200'], 
  },
};

export default function () {
  const url = 'http://127.0.0.1:8080/transactions';

  const payload = JSON.stringify({
    tx: JSON.stringify({
      payload: JSON.stringify({
        contractId: 'contract_xyz',
        method: 'charge_usage',
        args: ['device_burst', '100'],
        sequenceNumber: 1,
      }),
      signature: '00'.repeat(64),
      publicKey: '00'.repeat(32),
    }),
  });

  const params = { headers: { 'Content-Type': 'application/json' } };
  const res = http.post(url, payload, params);

  check(res, {
    'is status 200 or 401': (r) => r.status === 200 || r.status === 401,
  });

  sleep(1);
}
