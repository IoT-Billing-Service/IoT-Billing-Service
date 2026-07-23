export async function verifyProduction({ deploymentUrl, fetchImpl = fetch }) {
  const normalizedUrl = deploymentUrl?.replace(/\/$/, '');

  if (!normalizedUrl) throw new Error('DEPLOYMENT_URL is required.');

  const timeout = AbortSignal.timeout(30_000);
  const health = await fetchImpl(`${normalizedUrl}/health`, { signal: timeout });
  if (!health.ok) throw new Error(`Health check failed with HTTP ${health.status}.`);

  const metrics = await fetchImpl(`${normalizedUrl}/metrics`, { signal: timeout });
  if (!metrics.ok) throw new Error(`Metrics check failed with HTTP ${metrics.status}.`);

  const body = await metrics.text();
  for (const metric of ['billing_operation_duration_ms', 'billing_signature_failures_total']) {
    if (!body.includes(metric)) throw new Error(`Required production metric is missing: ${metric}.`);
  }

  return normalizedUrl;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const verifiedUrl = await verifyProduction({ deploymentUrl: process.env.DEPLOYMENT_URL });
  console.log(`Production verification passed for ${verifiedUrl}.`);
}
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
