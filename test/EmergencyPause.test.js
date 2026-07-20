const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("IoTBillingService emergency pause", function () {
  let billing;
  let admin;
  let guardian;
  let recovery;
  let device;

  const rate = 10n;

  async function registerDevice() {
    const timestamp = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    const signature = await device.signTypedData(
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
      { deviceId: device.address, metadataHash: "bafy-device", timestamp },
    );
    await billing.registerDevice(device.address, "bafy-device", signature, timestamp);
  }

  beforeEach(async function () {
    [admin, guardian, recovery, device] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("IoTBillingService");
    billing = await Factory.deploy();
    await billing.initialize(admin.address, rate);
    await billing.grantRole(await billing.EMERGENCY_PAUSER_ROLE(), guardian.address);
    await billing.grantRole(await billing.EMERGENCY_RECOVERY_ROLE(), recovery.address);
  });

  it("only the emergency guardian can pause and records the incident id", async function () {
    const incidentId = ethers.keccak256(ethers.toUtf8Bytes("INC-2026-071"));

    await expect(billing.connect(device).emergencyPause(incidentId)).to.be.reverted;
    await expect(billing.connect(guardian).emergencyPause(incidentId)).to.emit(billing, "EmergencyPaused");
    expect(await billing.paused()).to.equal(true);
  });

  it("blocks billing and payment while paused, without consuming a nonce", async function () {
    await registerDevice();
    const timestamp = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    const signedBilling = async (nonce) => device.signTypedData(
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
      { deviceId: device.address, usageUnits: 3n, ratePerUnit: rate, timestamp, nonce },
    );
    const paidNonce = 80n;
    const paymentReceipt = await (await billing.recordBilling(
      device.address, 3n, rate, timestamp, paidNonce, await signedBilling(paidNonce),
    )).wait();
    const paymentEvent = paymentReceipt.logs
      .map((log) => {
        try { return billing.interface.parseLog(log); } catch { return null; }
      })
      .find((event) => event && event.name === "BillingRecorded");
    const txHash = paymentEvent.args.txHash;

    const nonce = 81n;
    const signature = await signedBilling(nonce);

    await billing.connect(guardian).pause();
    await expect(billing.recordBilling(device.address, 3n, rate, timestamp, nonce, signature))
      .to.be.revertedWith("Pausable: paused");
    expect(await billing.usedNonces(nonce)).to.equal(false);
    await expect(billing.processPayment(txHash, { value: 30n })).to.be.revertedWith("Pausable: paused");
  });

  it("requires the separate recovery authority to resume", async function () {
    await billing.connect(guardian).pause();
    await expect(billing.connect(guardian).unpause()).to.be.reverted;
    await expect(billing.connect(recovery).unpause()).to.emit(billing, "EmergencyUnpaused");
    expect(await billing.paused()).to.equal(false);
  });

  it("also blocks V2 subscription and discount mutations", async function () {
    const V2 = await ethers.getContractFactory("IoTBillingServiceV2");
    const v2 = await V2.deploy();
    await v2.initialize(admin.address, rate);
    await v2.initializeV2();
    await v2.grantRole(await v2.EMERGENCY_PAUSER_ROLE(), guardian.address);

    const timestamp = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    const signature = await device.signTypedData(
      {
        name: "IoTBillingService",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await v2.getAddress(),
      },
      {
        DeviceRegistration: [
          { name: "deviceId", type: "address" },
          { name: "metadataHash", type: "string" },
          { name: "timestamp", type: "uint256" },
        ],
      },
      { deviceId: device.address, metadataHash: "bafy-v2-device", timestamp },
    );
    await v2.registerDevice(device.address, "bafy-v2-device", signature, timestamp);
    await v2.connect(guardian).pause();

    await expect(v2.createSubscription(device.address, 1, 3600)).to.be.revertedWith("Pausable: paused");
    await expect(v2.updateTierDiscount(1, 100)).to.be.revertedWith("Pausable: paused");
  });
});
