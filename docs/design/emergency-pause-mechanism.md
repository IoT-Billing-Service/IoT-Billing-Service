# Emergency pause mechanism

## Decision

The billing proxy uses OpenZeppelin's `PausableUpgradeable` state as a fail-closed circuit breaker. `EMERGENCY_PAUSER_ROLE` is a hot, incident-response-only role that can pause immediately. `EMERGENCY_RECOVERY_ROLE` is a cold governance role and must be granted exclusively to `IoTTimelockController` in production. This separation allows a suspected compromise to be contained immediately but prevents a single responder from silently restoring service.

The pause gate covers every billing state transition: device registration/deactivation, billing records, payment processing, rate changes, and V2 subscription/discount changes. Reads, signature verification, role administration, and governance recovery remain available. A rejected transaction changes no nonce, balance, billing record, or device state.

`EmergencyPaused(guardian, incidentId, timestamp)` and `EmergencyUnpaused(recoveryAdmin, timestamp)` create an on-chain audit trail. `incidentId` is a hash of the incident ticket; it must never contain PCI data, device metadata, wallet-to-customer mappings, or other sensitive data.

## Security and compliance controls

- Billing records continue to use EIP-712 signatures and nonces; pausing does not weaken verification.
- The guardian should be a hardware-backed 2-of-3 (or stronger) security multisig, monitored continuously. It receives no billing, upgrade, or default-admin role.
- Recovery is a timelocked governance operation. The existing production timelock minimum is 48 hours, giving security and compliance teams time to validate remediation and preserve evidence.
- Keep private keys outside application hosts (HSM/KMS or multisig); never emit signatures, payment values tied to cardholders, or PCI data in events or metrics.
- Retain pause/unpause events, approval evidence, chain transaction hashes, and monitoring alerts under the SOC2 incident-retention policy.

## Deployment and monitoring

Set `PAUSE_GUARDIAN_ADDRESS` before deployment. `scripts/deploy.js` grants the guardian the pauser role and the deployed timelock the recovery role. After deployment, verify the proxy without writing state:

```bash
BILLING_PROXY_ADDRESS=0x... PAUSE_GUARDIAN_ADDRESS=0x... EMERGENCY_RECOVERY_ADDRESS=0x... \
npm run verify:emergency-pause -- --network sepolia
```

The chain event exporter must publish `billing_contract_paused` (0/1) and increment `billing_emergency_pause_events_total` for every `EmergencyPaused` event. Prometheus rules alert immediately on a pause, on an observed pause event, and when a paused state has no matching exporter event. Existing `HighBillingLatency` remains the P99 <200 ms service objective; pause checks are constant-time storage reads and do not add a billing-path round trip.

## Incident procedure

1. Guardian submits `emergencyPause(keccak256(incident-ticket-id))`; capture the transaction hash and alert timestamp.
2. Confirm `paused() == true`, stop off-chain billing submission/retries, and preserve logs and signer evidence.
3. Investigate, remediate, test the fix on a fork/testnet, and obtain security/compliance approval.
4. Schedule `unpause()` through the timelock. After its delay, execute and confirm the unpause event and normal signature-verification/error-rate metrics.

Do not use unpause to bypass the change-management process. If the guardian or recovery authority is compromised, keep the contract paused and rotate roles through the default-admin/timelock governance process.
