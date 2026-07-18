const { ethers, upgrades } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);

  // Configuration
  const INITIAL_RATE = ethers.parseEther("0.001"); // 0.001 ETH per unit
  const MIN_DELAY = 172800; // 48 hours
  const PROPOSERS = [process.env.PROPOSER_ADDRESS || deployer.address];
  const EXECUTORS = [process.env.EXECUTOR_ADDRESS || deployer.address];

  // 1. Deploy Implementation V1
  console.log("\n📦 Deploying IoTBillingService V1...");
  const IoTBillingService = await ethers.getContractFactory("IoTBillingService");
  const billingImpl = await IoTBillingService.deploy();
  await billingImpl.waitForDeployment();
  console.log("✅ Implementation V1 deployed to:", await billingImpl.getAddress());

  // 2. Deploy Timelock Controller
  console.log("\n⏱️  Deploying TimelockController...");
  const IoTTimelockController = await ethers.getContractFactory("IoTTimelockController");
  const timelock = await IoTTimelockController.deploy(
    MIN_DELAY,
    PROPOSERS,
    EXECUTORS,
    deployer.address
  );
  await timelock.waitForDeployment();
  console.log("✅ Timelock deployed to:", await timelock.getAddress());

  // 3. Deploy Proxy
  console.log("\n🔗 Deploying Proxy...");
  const initData = billingImpl.interface.encodeFunctionData("initialize", [
    deployer.address,
    INITIAL_RATE,
  ]);

  const IoTBillingProxy = await ethers.getContractFactory("IoTBillingProxy");
  const proxy = await IoTBillingProxy.deploy(await billingImpl.getAddress(), initData);
  await proxy.waitForDeployment();
  console.log("✅ Proxy deployed to:", await proxy.getAddress());

  // 4. Approve proxy in timelock
  console.log("\n🔐 Approving proxy in timelock...");
  const tx = await timelock.approveTarget(await proxy.getAddress());
  await tx.wait();
  console.log("✅ Proxy approved in timelock");

  // 5. Setup roles
  const billing = await ethers.getContractAt("IoTBillingService", await proxy.getAddress());
  
  console.log("\n👥 Setting up roles...");
  
  // Grant UPGRADE_ADMIN to timelock (critical: timelock controls upgrades)
  await (await billing.grantRole(await billing.UPGRADE_ADMIN_ROLE(), await timelock.getAddress())).wait();
  console.log("  - UPGRADE_ADMIN_ROLE granted to Timelock");

  // Grant DEFAULT_ADMIN to timelock (optional, for parameter changes)
  await (await billing.grantRole(await billing.DEFAULT_ADMIN_ROLE(), await timelock.getAddress())).wait();
  console.log("  - DEFAULT_ADMIN_ROLE granted to Timelock");

  // Renounce deployer admin (decentralization)
  // await (await billing.renounceRole(await billing.DEFAULT_ADMIN_ROLE(), deployer.address)).wait();
  // console.log("  - Deployer renounced DEFAULT_ADMIN_ROLE");

  // 6. Save deployment info
  const deploymentInfo = {
    network: (await ethers.provider.getNetwork()).name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    contracts: {
      implementationV1: await billingImpl.getAddress(),
      timelock: await timelock.getAddress(),
      proxy: await proxy.getAddress(),
    },
    config: {
      initialRate: INITIAL_RATE.toString(),
      minDelay: MIN_DELAY,
      proposers: PROPOSERS,
      executors: EXECUTORS,
    },
    timestamp: new Date().toISOString(),
  };

  const deploymentPath = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentPath)) {
    fs.mkdirSync(deploymentPath, { recursive: true });
  }

  fs.writeFileSync(
    path.join(deploymentPath, `deployment-${deploymentInfo.network}.json`),
    JSON.stringify(deploymentInfo, null, 2)
  );

  console.log("\n📋 Deployment Summary:");
  console.log("═══════════════════════════════════════════════════");
  console.log(`Implementation V1: ${await billingImpl.getAddress()}`);
  console.log(`Timelock:           ${await timelock.getAddress()}`);
  console.log(`Proxy:              ${await proxy.getAddress()}`);
  console.log(`Rate per Unit:      ${ethers.formatEther(INITIAL_RATE)} ETH`);
  console.log(`Min Delay:          ${MIN_DELAY / 3600} hours`);
  console.log("═══════════════════════════════════════════════════");

  // 7. Verify setup
  console.log("\n🔍 Verification:");
  console.log(`Proxy implementation: ${await proxy.implementation()}`);
  console.log(`Billing version: ${await billing.version()}`);
  console.log(`Timelock min delay: ${await timelock.getMinDelay()}`);

  return deploymentInfo;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });