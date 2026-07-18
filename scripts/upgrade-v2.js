const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer, proposer, executor] = await ethers.getSigners();

  // Load deployment info
  const deploymentPath = path.join(__dirname, "..", "deployments");
  const files = fs.readdirSync(deploymentPath);
  const latestDeployment = files
    .filter(f => f.startsWith("deployment-"))
    .sort()
    .pop();

  if (!latestDeployment) {
    throw new Error("No deployment found. Run deploy.js first.");
  }

  const deployment = JSON.parse(
    fs.readFileSync(path.join(deploymentPath, latestDeployment), "utf8")
  );

  console.log("🚀 Starting V2 Upgrade Process via Timelock");
  console.log("═══════════════════════════════════════════════════");
  console.log(`Proxy: ${deployment.contracts.proxy}`);
  console.log(`Timelock: ${deployment.contracts.timelock}`);

  // 1. Deploy V2 Implementation
  console.log("\n📦 Deploying V2 Implementation...");
  const IoTBillingServiceV2 = await ethers.getContractFactory("IoTBillingServiceV2");
  const v2Impl = await IoTBillingServiceV2.deploy();
  await v2Impl.waitForDeployment();
  console.log("✅ V2 Implementation deployed to:", await v2Impl.getAddress());

  // 2. Prepare upgrade call
  const billing = await ethers.getContractAt("IoTBillingService", deployment.contracts.proxy);
  const initV2Data = v2Impl.interface.encodeFunctionData("initializeV2");
  const upgradeData = billing.interface.encodeFunctionData("upgradeToAndCall", [
    await v2Impl.getAddress(),
    initV2Data,
  ]);

  const timelock = await ethers.getContractAt("IoTTimelockController", deployment.contracts.timelock);

  const salt = ethers.keccak256(ethers.toUtf8Bytes(`upgrade-v2-${Date.now()}`));
  const predecessor = ethers.ZeroHash;
  const delay = await timelock.getMinDelay();

  console.log("\n⏱️  Scheduling upgrade in Timelock...");
  console.log(`Delay: ${delay} seconds (${delay / 3600} hours)`);

  // 3. Schedule upgrade
  const scheduleTx = await timelock.connect(proposer).schedule(
    deployment.contracts.proxy,
    0,
    upgradeData,
    predecessor,
    salt,
    delay
  );
  await scheduleTx.wait();

  const operationId = await timelock.hashOperation(
    deployment.contracts.proxy,
    0,
    upgradeData,
    predecessor,
    salt
  );

  console.log("✅ Upgrade scheduled");
  console.log(`Operation ID: ${operationId}`);

  // 4. Save operation details
  const upgradeInfo = {
    version: 2,
    previousImplementation: deployment.contracts.implementationV1,
    newImplementation: await v2Impl.getAddress(),
    proxy: deployment.contracts.proxy,
    timelock: deployment.contracts.timelock,
    operation: {
      id: operationId,
      target: deployment.contracts.proxy,
      data: upgradeData,
      salt,
      predecessor,
      delay: delay.toString(),
      scheduledAt: new Date().toISOString(),
      executableAfter: new Date(Date.now() + delay * 1000).toISOString(),
    },
    status: "SCHEDULED",
  };

  fs.writeFileSync(
    path.join(deploymentPath, `upgrade-v2-${Date.now()}.json`),
    JSON.stringify(upgradeInfo, null, 2)
  );

  console.log("\n📋 Next Steps:");
  console.log("═══════════════════════════════════════════════════");
  console.log("1. Wait for timelock delay to pass");
  console.log(`   Executable after: ${upgradeInfo.operation.executableAfter}`);
  console.log("");
  console.log("2. Execute upgrade with:");
  console.log(`   npx hardhat run scripts/execute-upgrade.js --network <network>`);
  console.log("");
  console.log("3. Verify new implementation:");
  console.log(`   npx hardhat verify --network <network> ${await v2Impl.getAddress()}`);
  console.log("═══════════════════════════════════════════════════");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });