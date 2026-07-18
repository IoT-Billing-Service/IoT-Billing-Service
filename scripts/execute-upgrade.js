const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function prompt(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  const [, , executor] = await ethers.getSigners();

  // Find latest upgrade file
  const deploymentPath = path.join(__dirname, "..", "deployments");
  const files = fs.readdirSync(deploymentPath);
  const upgradeFiles = files.filter(f => f.startsWith("upgrade-v2-"));

  if (upgradeFiles.length === 0) {
    throw new Error("No upgrade file found. Run upgrade-v2.js first.");
  }

  const latestUpgrade = upgradeFiles.sort().pop();
  const upgrade = JSON.parse(
    fs.readFileSync(path.join(deploymentPath, latestUpgrade), "utf8")
  );

  console.log("⚡ Executing Scheduled Upgrade");
  console.log("═══════════════════════════════════════════════════");
  console.log(`Operation ID: ${upgrade.operation.id}`);
  console.log(`Target: ${upgrade.operation.target}`);
  console.log(`New Implementation: ${upgrade.newImplementation}`);

  const timelock = await ethers.getContractAt("IoTTimelockController", upgrade.timelock);

  // Check if ready
  const ready = await timelock.isOperationReady(upgrade.operation.id);
  if (!ready) {
    const timestamp = await timelock.getTimestamp(upgrade.operation.id);
    const now = Math.floor(Date.now() / 1000);
    const waitTime = Number(timestamp) - now;
    console.error(`\n❌ Upgrade not ready yet. Wait ${waitTime} more seconds.`);
    process.exit(1);
  }

  // Confirm execution
  const confirm = await prompt("\n⚠️  This will execute the contract upgrade. Type 'EXECUTE' to confirm: ");
  if (confirm !== "EXECUTE") {
    console.log("Upgrade cancelled.");
    process.exit(0);
  }

  console.log("\n🔨 Executing upgrade...");

  const tx = await timelock.connect(executor).execute(
    upgrade.operation.target,
    0,
    upgrade.operation.data,
    upgrade.operation.predecessor,
    upgrade.operation.salt
  );

  const receipt = await tx.wait();
  console.log("✅ Upgrade executed successfully!");
  console.log(`Transaction: ${receipt.hash}`);

  // Verify
  const proxy = await ethers.getContractAt("IoTBillingService", upgrade.operation.target);
  const newVersion = await proxy.version();
  const newImpl = await proxy.implementation();

  console.log("\n📊 Post-Upgrade Verification:");
  console.log(`Version: ${newVersion}`);
  console.log(`Implementation: ${newImpl}`);
  console.log(`Expected: ${upgrade.newImplementation}`);
  console.log(`Match: ${newImpl.toLowerCase() === upgrade.newImplementation.toLowerCase() ? "✅" : "❌"}`);

  // Update status
  upgrade.status = "EXECUTED";
  upgrade.execution = {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    executedAt: new Date().toISOString(),
    gasUsed: receipt.gasUsed.toString(),
  };

  fs.writeFileSync(
    path.join(deploymentPath, latestUpgrade),
    JSON.stringify(upgrade, null, 2)
  );

  rl.close();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });