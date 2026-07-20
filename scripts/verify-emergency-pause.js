const { ethers } = require("hardhat");

async function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function main() {
  const proxy = await required("BILLING_PROXY_ADDRESS");
  const guardian = await required("PAUSE_GUARDIAN_ADDRESS");
  const recovery = await required("EMERGENCY_RECOVERY_ADDRESS");
  const billing = await ethers.getContractAt("IoTBillingService", proxy);

  const [hasGuardian, hasRecovery, paused] = await Promise.all([
    billing.hasRole(await billing.EMERGENCY_PAUSER_ROLE(), guardian),
    billing.hasRole(await billing.EMERGENCY_RECOVERY_ROLE(), recovery),
    billing.paused(),
  ]);

  if (!hasGuardian || !hasRecovery || paused) {
    throw new Error(`Unsafe emergency-pause configuration: guardian=${hasGuardian}, recovery=${hasRecovery}, paused=${paused}`);
  }
  console.log("Emergency-pause deployment verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
