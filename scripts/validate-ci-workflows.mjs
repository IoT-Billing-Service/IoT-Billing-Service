import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function read(relativePath) {
  return readFile(resolve(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const [ci, deploy, alerts] = await Promise.all([
  read('.github/workflows/ci.yml'),
  read('.github/workflows/deploy-production.yml'),
  read('monitoring/billing_alerts.yml'),
]);

assert(ci.includes('cancel-in-progress: true'), 'CI must cancel superseded runs.');
assert(ci.includes('dorny/paths-filter@v3'), 'CI must detect affected components before scheduling work.');
for (const job of ['backend:', 'frontend:', 'contracts:', 'dependency-audit:']) {
  assert(ci.includes(`  ${job}`), `CI is missing the ${job.slice(0, -1)} parallel lane.`);
}
assert(ci.includes('npm ci --ignore-scripts'), 'Node dependency installation must disable lifecycle scripts.');
assert(ci.includes('npm audit --omit=dev --audit-level=high'), 'CI must audit production dependencies.');
assert(deploy.includes('environment: production'), 'Production deployment must be environment protected.');
assert(deploy.includes('RENDER_DEPLOY_HOOK: ${{ secrets.RENDER_DEPLOY_HOOK }}'), 'Deployment hook must remain a GitHub secret.');
assert(deploy.includes('scripts/verify-production.mjs'), 'Deployment must perform post-deploy verification.');
assert(alerts.includes('HighBillingLatency'), 'Monitoring must alert on the billing latency target.');
assert(alerts.includes('FailedSignatureVerification'), 'Monitoring must alert on cryptographic verification failures.');

console.log('CI workflow and monitoring policy validation passed.');
