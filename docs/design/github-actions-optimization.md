# GitHub Actions optimization and release controls

## Outcome

The CI pipeline first identifies affected components, then runs the backend, frontend, contract, workflow-policy, and dependency-audit lanes concurrently as needed. It uses lockfile caches, cancels obsolete runs for the same ref, and places a time limit on every job. A frontend test lane is retained with `--passWithNoTests` until frontend tests are added; the build, lint, and typecheck lanes still execute.

## Security and compliance controls

Pull-request CI has read-only repository permissions and never receives deployment credentials. Node dependencies are installed with lifecycle scripts disabled, and each Node lockfile is audited for high- or critical-severity production vulnerabilities. The backend's signed configuration and transaction-verification tests run before a production deployment. Contract tests run independently in the Rust lane.

Production release is manual and serialized. It is bound to GitHub's `production` environment, which must be configured with required reviewers and restricted deployment branches. The Render deploy hook is read only from the `RENDER_DEPLOY_HOOK` GitHub environment secret. This separation provides deploy approvals and an auditable release trail suitable for PCI-DSS/SOC 2 change management; it does not by itself certify compliance.

## Deployment and monitoring

After the managed-platform hook is triggered, the deployment workflow requires `/health` and `/metrics` to respond, and requires the billing latency and signature-failure metrics to be exposed. Prometheus alerts in `monitoring/billing_alerts.yml` enforce the <200 ms billing P99 target and report signature-verification failures. Configure Prometheus to load that file and route critical alerts to the on-call service before enabling production deployment.

## Required repository configuration

1. Create the GitHub `production` environment; require reviewers and restrict it to `main` (or approved release branches).
2. Add `RENDER_DEPLOY_HOOK` to that environment, never as a repository-level secret.
3. Make the CI checks required in branch protection: Backend quality and tests, Frontend quality and tests, Contracts checks, Workflow and monitoring policy, and Dependency vulnerability audit.
4. Configure the deployment URL passed to the workflow to be the externally reachable backend URL. It must expose `/health` and authenticated-or-network-restricted `/metrics`.

## Operational limits

The post-deploy metric check confirms instrumentation presence, not a statistically valid P99 sample. Prometheus alerting is the continuous SLO authority. A failed post-deploy verification stops the workflow and must be handled through the incident response runbook or a managed-platform rollback; automatic rollback is deliberately not assumed because it can create unsafe state transitions for billing.
