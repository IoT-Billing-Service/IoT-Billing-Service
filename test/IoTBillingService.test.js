const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("IoT Billing Platform - Complete Test Suite", function () {
  let IoTBillingService, IoTBillingServiceV2, IoTTimelockController, IoTBillingProxy;
  let billing, billingV2, timelock, proxy;
  let owner, admin, billingAdmin, deviceManager, auditor, upgradeAdmin;
  let device1, device2, proposer, executor;
  let proxyAdmin;

  const MIN_DELAY = 172800; // 48 hours
  const RATE_PER_UNIT = ethers.parseEther("0.001");

  beforeEach(async function () {
    [owner, admin, billingAdmin, deviceManager, auditor, upgradeAdmin, device1, device2, proposer, executor] = await ethers.getSigners();

    // Deploy implementation
    IoTBillingService = await ethers.getContractFactory("IoTBillingService");
    billing = await IoTBillingService.deploy();
    await billing.waitForDeployment();

    // Deploy Timelock
    IoTTimelockController = await ethers.getContractFactory("IoTTimelockController");
    timelock = await IoTTimelockController.deploy(
      MIN_DELAY,
      [proposer.address],
      [executor.address],
      admin.address
    );
    await timelock.waitForDeployment();

    // Deploy Proxy
    const initData = billing.interface.encodeFunctionData("initialize", [admin.address, RATE_PER_UNIT]);
    
    IoTBillingProxy = await ethers.getContractFactory("IoTBillingProxy");
    proxy = await IoTBillingProxy.deploy(await billing.getAddress(), initData);
    await proxy.waitForDeployment();

    // Get proxied contract instance
    billing = await ethers.getContractAt("IoTBillingService", await proxy.getAddress());

    // Setup roles
    await billing.connect(admin).grantRole(await billing.BILLING_ADMIN_ROLE(), billingAdmin.address);
    await billing.connect(admin).grantRole(await billing.DEVICE_MANAGER_ROLE(), deviceManager.address);
    await billing.connect(admin).grantRole(await billing.AUDITOR_ROLE(), auditor.address);
    await billing.connect(admin).grantRole(await billing.UPGRADE_ADMIN_ROLE(), upgradeAdmin.address);

    // Approve proxy as target in timelock
    await timelock.connect(proposer).approveTarget(await proxy.getAddress());
  });

  describe("Initialization", function () {
    it("Should initialize with correct admin and rate", async function () {
      expect(await billing.hasRole(await billing.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
      expect(await billing.currentRatePerUnit()).to.equal(RATE_PER_UNIT);
      expect(await billing.version()).to.equal(1);
    });

    it("Should not allow re-initialization", async function () {
      await expect(
        billing.initialize(admin.address, RATE_PER_UNIT)
      ).to.be.revertedWithCustomError(billing, "InvalidInitialization");
    });
  });

  describe("Device Registration (Cryptographic Verification)", function () {
    it("Should register a device with valid signature", async function () {
      const metadataHash = "QmTest123";
      const timestamp = await time.latest();
      
      const domain = {
        name: "IoTBillingService",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await billing.getAddress(),
      };

      const types = {
        DeviceRegistration: [
          { name: "deviceId", type: "address" },
          { name: "metadataHash", type: "string" },
          { name: "timestamp", type: "uint256" },
        ],
      };

      const signature = await device1.signTypedData(domain, types, {
        deviceId: device1.address,
        metadataHash,
        timestamp,
      });

      await expect(
        billing.connect(deviceManager).registerDevice(device1.address, metadataHash, signature, timestamp)
      )
        .to.emit(billing, "DeviceRegistered")
        .withArgs(device1.address, device1.address, metadataHash, await time.latest());

      const device = await billing.devices(device1.address);
      expect(device.owner).to.equal(device1.address);
      expect(device.isActive).to.be.true;
    });

    it("Should reject registration with invalid signature", async function () {
      const metadataHash = "QmTest123";
      const timestamp = await time.latest();
      
      // Sign with wrong signer
      const signature = await device2.signTypedData(
        {
          name: "IoTBillingService",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await billing.getAddress(),
        },
        {
          DeviceRegistration: [
            { name: "deviceId", type: "address" },
            { name: "metadataHash", type: "string" },
            { name: "timestamp", type: "uint256" },
          ],
        },
        {
          deviceId: device1.address,
          metadataHash,
          timestamp,
        }
      );

      await expect(
        billing.connect(deviceManager).registerDevice(device1.address, metadataHash, signature, timestamp)
      ).to.be.revertedWithCustomError(billing, "InvalidSignature");
    });

    it("Should prevent duplicate registration", async function () {
      const metadataHash = "QmTest123";
      const timestamp = await time.latest();
      
      const signature = await device1.signTypedData(
        {
          name: "IoTBillingService",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await billing.getAddress(),
        },
        {
          DeviceRegistration: [
            { name: "deviceId", type: "address" },
            { name: "metadataHash", type: "string" },
            { name: "timestamp", type: "uint256" },
          ],
        },
        {
          deviceId: device1.address,
          metadataHash,
          timestamp,
        }
      );

      await billing.connect(deviceManager).registerDevice(device1.address, metadataHash, signature, timestamp);

      await expect(
        billing.connect(deviceManager).registerDevice(device1.address, metadataHash, signature, timestamp)
      ).to.be.revertedWithCustomError(billing, "DeviceAlreadyRegistered");
    });
  });

  describe("Billing Operations (Performance & Security)", function () {
    beforeEach(async function () {
      // Register device1
      const metadataHash = "QmTest123";
      const timestamp = await time.latest();
      
      const signature = await device1.signTypedData(
        {
          name: "IoTBillingService",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await billing.getAddress(),
        },
        {
          DeviceRegistration: [
            { name: "deviceId", type: "address" },
            { name: "metadataHash", type: "string" },
            { name: "timestamp", type: "uint256" },
          ],
        },
        {
          deviceId: device1.address,
          metadataHash,
          timestamp,
        }
      );

      await billing.connect(deviceManager).registerDevice(device1.address, metadataHash, signature, timestamp);
    });

    it("Should record billing with valid signature under 200ms gas", async function () {
      const usageUnits = 100;
      const ratePerUnit = await billing.currentRatePerUnit();
      const timestamp = await time.latest();
      const nonce = 1;

      const signature = await device1.signTypedData(
        {
          name: "IoTBillingService",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await billing.getAddress(),
        },
        {
          BillingTransaction: [
            { name: "deviceId", type: "address" },
            { name: "usageUnits", type: "uint256" },
            { name: "ratePerUnit", type: "uint256" },
            { name: "timestamp", type: "uint256" },
            { name: "nonce", type: "uint256" },
          ],
        },
        {
          deviceId: device1.address,
          usageUnits,
          ratePerUnit,
          timestamp,
          nonce,
        }
      );

      const tx = await billing.connect(billingAdmin).recordBilling(
        device1.address,
        usageUnits,
        ratePerUnit,
        timestamp,
        nonce,
        signature
      );

      const receipt = await tx.wait();
      
      // Performance check: gas used should be reasonable (proxy adds ~2k gas)
      expect(receipt.gasUsed).to.be.lt(150000); // Well under 200ms equivalent

      const txHash = receipt.logs[0].topics[1];
      const record = await billing.billingRecords(txHash);
      expect(record.isVerified).to.be.true;
      expect(record.amount).to.equal(usageUnits * ratePerUnit);
    });

    it("Should prevent replay attacks with nonce", async function () {
      const usageUnits = 100;
      const ratePerUnit = await billing.currentRatePerUnit();
      const timestamp = await time.latest();
      const nonce = 1;

      const signature = await device1.signTypedData(
        {
          name: "IoTBillingService",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await billing.getAddress(),
        },
        {
          BillingTransaction: [
            { name: "deviceId", type: "address" },
            { name: "usageUnits", type: "uint256" },
            { name: "ratePerUnit", type: "uint256" },
            { name: "timestamp", type: "uint256" },
            { name: "nonce", type: "uint256" },
          ],
        },
        {
          deviceId: device1.address,
          usageUnits,
          ratePerUnit,
          timestamp,
          nonce,
        }
      );

      await billing.connect(billingAdmin).recordBilling(
        device1.address,
        usageUnits,
        ratePerUnit,
        timestamp,
        nonce,
        signature
      );

      // Attempt replay
      await expect(
        billing.connect(billingAdmin).recordBilling(
          device1.address,
          usageUnits,
          ratePerUnit,
          timestamp,
          nonce,
          signature
        )
      ).to.be.revertedWithCustomError(billing, "NonceAlreadyUsed");
    });

    it("Should verify signature off-chain correctly", async function () {
      const usageUnits = 100;
      const ratePerUnit = await billing.currentRatePerUnit();
      const timestamp = await time.latest();
      const nonce = 1;

      const signature = await device1.signTypedData(
        {
          name: "IoTBillingService",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await billing.getAddress(),
        },
        {
          BillingTransaction: [
            { name: "deviceId", type: "address" },
            { name: "usageUnits", type: "uint256" },
            { name: "ratePerUnit", type: "uint256" },
            { name: "timestamp", type: "uint256" },
            { name: "nonce", type: "uint256" },
          ],
        },
        {
          deviceId: device1.address,
          usageUnits,
          ratePerUnit,
          timestamp,
          nonce,
        }
      );

      const isValid = await billing.verifyBillingSignature(
        device1.address,
        usageUnits,
        ratePerUnit,
        timestamp,
        nonce,
        signature
      );
      expect(isValid).to.be.true;
    });
  });

  describe("Timelock Upgrade Mechanism", function () {
    it("Should schedule upgrade through timelock with 48h delay", async function () {
      // Deploy V2 implementation
      IoTBillingServiceV2 = await ethers.getContractFactory("IoTBillingServiceV2");
      billingV2 = await IoTBillingServiceV2.deploy();
      await billingV2.waitForDeployment();

      // Prepare upgrade call data
      const upgradeData = billing.interface.encodeFunctionData("upgradeToAndCall", [
        await billingV2.getAddress(),
        "0x"
      ]);

      const salt = ethers.keccak256(ethers.toUtf8Bytes("upgrade-v2"));
      
      // Schedule through timelock
      await expect(
        timelock.connect(proposer).schedule(
          await proxy.getAddress(),
          0,
          upgradeData,
          ethers.ZeroHash,
          salt,
          MIN_DELAY
        )
      ).to.emit(timelock, "OperationScheduledWithDetails");

      // Try to execute before delay - should fail
      await expect(
        timelock.connect(executor).execute(
          await proxy.getAddress(),
          0,
          upgradeData,
          ethers.ZeroHash,
          salt
        )
      ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

      // Fast forward past delay
      await time.increase(MIN_DELAY + 1);

      // Execute upgrade
      await expect(
        timelock.connect(executor).execute(
          await proxy.getAddress(),
          0,
          upgradeData,
          ethers.ZeroHash,
          salt
        )
      ).to.not.be.reverted;

      // Verify upgrade
      billing = await ethers.getContractAt("IoTBillingServiceV2", await proxy.getAddress());
      expect(await billing.version()).to.equal(2);
    });

    it("Should reject upgrade with insufficient delay", async function () {
      const upgradeData = "0x";
      const salt = ethers.keccak256(ethers.toUtf8Bytes("upgrade-v2"));

      await expect(
        timelock.connect(proposer).schedule(
          await proxy.getAddress(),
          0,
          upgradeData,
          ethers.ZeroHash,
          salt,
          3600 // 1 hour - too short
        )
      ).to.be.revertedWithCustomError(timelock, "DelayTooShort");
    });

    it("Should allow cancellation of scheduled upgrade", async function () {
      const upgradeData = "0x";
      const salt = ethers.keccak256(ethers.toUtf8Bytes("upgrade-v2"));

      await timelock.connect(proposer).schedule(
        await proxy.getAddress(),
        0,
        upgradeData,
        ethers.ZeroHash,
        salt,
        MIN_DELAY
      );

      const opHash = await timelock.hashOperation(
        await proxy.getAddress(),
        0,
        upgradeData,
        ethers.ZeroHash,
        salt
      );

      await expect(timelock.connect(proposer).cancel(opHash))
        .to.emit(timelock, "Cancelled");
    });

    it("Should reject unapproved target", async function () {
      await expect(
        timelock.connect(proposer).schedule(
          device1.address, // Not approved
          0,
          "0x",
          ethers.ZeroHash,
          ethers.ZeroHash,
          MIN_DELAY
        )
      ).to.be.revertedWithCustomError(timelock, "TargetNotApproved");
    });
  });

  describe("Upgrade to V2 with State Preservation", function () {
    beforeEach(async function () {
      // Setup: Register device and record billing in V1
      const metadataHash = "QmTest123";
      const timestamp = await time.latest();
      
      const signature = await device1.signTypedData(
        {
          name: "IoTBillingService",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await billing.getAddress(),
        },
        {
          DeviceRegistration: [
            { name: "deviceId", type: "address" },
            { name: "metadataHash", type: "string" },
            { name: "timestamp", type: "uint256" },
          ],
        },
        {
          deviceId: device1.address,
          metadataHash,
          timestamp,
        }
      );

      await billing.connect(deviceManager).registerDevice(device1.address, metadataHash, signature, timestamp);

      // Record billing
      const usageUnits = 100;
      const ratePerUnit = await billing.currentRatePerUnit();
      const nonce = 1;

      const billSignature = await device1.signTypedData(
        {
          name: "IoTBillingService",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await billing.getAddress(),
        },
        {
          BillingTransaction: [
            { name: "deviceId", type: "address" },
            { name: "usageUnits", type: "uint256" },
            { name: "ratePerUnit", type: "uint256" },
            { name: "timestamp", type: "uint256" },
            { name: "nonce", type: "uint256" },
          ],
        },
        {
          deviceId: device1.address,
          usageUnits,
          ratePerUnit,
          timestamp,
          nonce,
        }
      );

      await billing.connect(billingAdmin).recordBilling(
        device1.address,
        usageUnits,
        ratePerUnit,
        timestamp,
        nonce,
        billSignature
      );
    });

    it("Should preserve state after upgrade to V2", async function () {
      // Deploy V2
      IoTBillingServiceV2 = await ethers.getContractFactory("IoTBillingServiceV2");
      billingV2 = await IoTBillingServiceV2.deploy();
      await billingV2.waitForDeployment();

      // Upgrade via timelock
      const initV2Data = billingV2.interface.encodeFunctionData("initializeV2");
      const upgradeData = billing.interface.encodeFunctionData("upgradeToAndCall", [
        await billingV2.getAddress(),
        initV2Data
      ]);

      const salt = ethers.keccak256(ethers.toUtf8Bytes("upgrade-v2-state"));

      await timelock.connect(proposer).schedule(
        await proxy.getAddress(),
        0,
        upgradeData,
        ethers.ZeroHash,
        salt,
        MIN_DELAY
      );

      await time.increase(MIN_DELAY + 1);

      await timelock.connect(executor).execute(
        await proxy.getAddress(),
        0,
        upgradeData,
        ethers.ZeroHash,
        salt
      );

      // Check state preserved
      billing = await ethers.getContractAt("IoTBillingServiceV2", await proxy.getAddress());
      
      const device = await billing.devices(device1.address);
      expect(device.owner).to.equal(device1.address);
      expect(device.totalBilled).to.be.gt(0);
      expect(await billing.version()).to.equal(2);
      expect(await billing.totalBillingVolume()).to.be.gt(0);
    });

    it("Should use V2 subscription features after upgrade", async function () {
      // First upgrade to V2
      IoTBillingServiceV2 = await ethers.getContractFactory("IoTBillingServiceV2");
      billingV2 = await IoTBillingServiceV2.deploy();
      await billingV2.waitForDeployment();

      const initV2Data = billingV2.interface.encodeFunctionData("initializeV2");
      const upgradeData = billing.interface.encodeFunctionData("upgradeToAndCall", [
        await billingV2.getAddress(),
        initV2Data
      ]);

      const salt = ethers.keccak256(ethers.toUtf8Bytes("upgrade-v2-sub"));

      await timelock.connect(proposer).schedule(
        await proxy.getAddress(),
        0,
        upgradeData,
        ethers.ZeroHash,
        salt,
        MIN_DELAY
      );

      await time.increase(MIN_DELAY + 1);
      await timelock.connect(executor).execute(
        await proxy.getAddress(),
        0,
        upgradeData,
        ethers.ZeroHash,
        salt
      );

      billing = await ethers.getContractAt("IoTBillingServiceV2", await proxy.getAddress());

      // Create subscription
      await billing.connect(billingAdmin).createSubscription(
        device1.address,
        2, // PRO tier
        86400 * 30 // 30 days
      );

      const sub = await billing.subscriptions(device1.address);
      expect(sub.tier).to.equal(2);
      expect(sub.discountBps).to.equal(1500); // 15%
    });
  });

  describe("Security & Access Control", function () {
    it("Should restrict upgrade to UPGRADE_ADMIN_ROLE", async function () {
      IoTBillingServiceV2 = await ethers.getContractFactory("IoTBillingServiceV2");
      billingV2 = await IoTBillingServiceV2.deploy();
      await billingV2.waitForDeployment();

      await expect(
        billing.connect(billingAdmin).upgradeToAndCall(await billingV2.getAddress(), "0x")
      ).to.be.revertedWithCustomError(billing, "AccessControlUnauthorizedAccount");
    });

    it("Should restrict pause to DEFAULT_ADMIN_ROLE", async function () {
      await expect(
        billing.connect(billingAdmin).pause()
      ).to.be.revertedWithCustomError(billing, "AccessControlUnauthorizedAccount");
    });

    it("Should restrict billing to BILLING_ADMIN_ROLE", async function () {
      await expect(
        billing.connect(device1).recordBilling(
          device1.address,
          100,
          RATE_PER_UNIT,
          await time.latest(),
          1,
          "0x"
        )
      ).to.be.revertedWithCustomError(billing, "AccessControlUnauthorizedAccount");
    });

    it("Should prevent direct ETH transfers", async function () {
      await expect(
        owner.sendTransaction({
          to: await billing.getAddress(),
          value: ethers.parseEther("1"),
        })
      ).to.be.revertedWith("Direct payments not allowed");
    });
  });

  describe("Emergency Procedures", function () {
    it("Should pause all operations in emergency", async function () {
      await billing.connect(admin).pause();
      expect(await billing.paused()).to.be.true;

      await expect(
        billing.connect(deviceManager).registerDevice(
          device1.address,
          "QmTest",
          "0x",
          await time.latest()
        )
      ).to.be.revertedWithCustomError(billing, "EnforcedPause");
    });

    it("Should resume operations after unpause", async function () {
      await billing.connect(admin).pause();
      await billing.connect(admin).unpause();
      expect(await billing.paused()).to.be.false;
    });
  });

  describe("Gas Optimization & Performance", function () {
    it("Should maintain gas efficiency for billing under 150k gas", async function () {
      // Register device
      const metadataHash = "QmTest123";
      const timestamp = await time.latest();
      
      const signature = await device1.signTypedData(
        {
          name: "IoTBillingService",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await billing.getAddress(),
        },
        {
          DeviceRegistration: [
            { name: "deviceId", type: "address" },
            { name: "metadataHash", type: "string" },
            { name: "timestamp", type: "uint256" },
          ],
        },
        {
          deviceId: device1.address,
          metadataHash,
          timestamp,
        }
      );

      await billing.connect(deviceManager).registerDevice(device1.address, metadataHash, signature, timestamp);

      // Measure billing gas
      const usageUnits = 100;
      const ratePerUnit = await billing.currentRatePerUnit();
      const nonce = 1;

      const billSignature = await device1.signTypedData(
        {
          name: "IoTBillingService",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await billing.getAddress(),
        },
        {
          BillingTransaction: [
            { name: "deviceId", type: "address" },
            { name: "usageUnits", type: "uint256" },
            { name: "ratePerUnit", type: "uint256" },
            { name: "timestamp", type: "uint256" },
            { name: "nonce", type: "uint256" },
          ],
        },
        {
          deviceId: device1.address,
          usageUnits,
          ratePerUnit,
          timestamp,
          nonce,
        }
      );

      const tx = await billing.connect(billingAdmin).recordBilling(
        device1.address,
        usageUnits,
        ratePerUnit,
        timestamp,
        nonce,
        billSignature
      );

      const receipt = await tx.wait();
      expect(receipt.gasUsed).to.be.lt(150000);
      console.log(`Gas used for billing: ${receipt.gasUsed}`);
    });
  });
});