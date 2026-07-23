import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyProduction } from '../../scripts/verify-production.mjs';

function response({ ok = true, status = 200, body = '' } = {}) {
  return { ok, status, text: async () => body };
}

test('verifies health and required billing metrics', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return url.endsWith('/health')
      ? response()
      : response({ body: 'billing_operation_duration_ms\\nbilling_signature_failures_total\\n' });
  };

  const result = await verifyProduction({ deploymentUrl: 'https://billing.example/', fetchImpl });

  assert.equal(result, 'https://billing.example');
  assert.deepEqual(requests, ['https://billing.example/health', 'https://billing.example/metrics']);
});

test('rejects a deployment that does not expose signature verification telemetry', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/health') ? response() : response({ body: 'billing_operation_duration_ms\\n' });

  await assert.rejects(
    verifyProduction({ deploymentUrl: 'https://billing.example', fetchImpl }),
    /billing_signature_failures_total/,
  );
});

test('rejects a failing health endpoint before accepting metrics', async () => {
  const fetchImpl = async () => response({ ok: false, status: 503 });

  await assert.rejects(
    verifyProduction({ deploymentUrl: 'https://billing.example', fetchImpl }),
    /Health check failed with HTTP 503/,
  );
});
