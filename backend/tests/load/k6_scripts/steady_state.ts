import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 50 }, // Ramp up to 50 virtual users
    { duration: '30s', target: 50 }, // Maintain 50 VU steady state
    { duration: '10s', target: 0 },  // Ramp down
  ],
  thresholds: {
    // Assert P99 < 200ms
    http_req_duration: ['p(99)<200'], 
    http_req_failed: ['rate<0.01'],   // Error rate < 1%
  },
};

export default function () {
  const url = 'http://127.0.0.1:8080/transactions'; // pointing to mock RPC or backend API

  const payload = JSON.stringify({
    tx: JSON.stringify({
      payload: JSON.stringify({
        contractId: 'contract_xyz',
        method: 'charge_usage',
        args: ['device_k6', '100'],
        sequenceNumber: 1,
      }),
      signature: '00'.repeat(64), // dummy signature
      publicKey: '00'.repeat(32), // dummy public key
    }),
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
    },
  };

  const res = http.post(url, payload, params);

  check(res, {
    'status is 200 or 401': (r) => r.status === 200 || r.status === 401,
  });

  sleep(1);
}
