import { Router, Request, Response } from 'express';
import { ZkVerifier } from '../services/zkVerifier';

export const telemetryRouter = Router();

// Simulated active on-ledger node escrows and tariff config
const MOCK_LEDGER_STATE = {
  activeTariff: {
    id: 'TARIFF-ENV-STD',
    baseRate: 0.002, // XLM
    sizeRateKB: 0.001, // XLM
    gasBuffer: 0.0005, // XLM
  },
  nodes: new Map<string, { balance: number; name: string }>()
};

// Seed Munich node for mock queries
MOCK_LEDGER_STATE.nodes.set('DePIN-ENV-081', { balance: 45.25, name: 'Munich Air Quality Sensor' });

/**
 * @route POST /api/telemetry/ingest
 * @desc Ingest telemetry from a remote hardware node, verifying cryptographic range proof and billing
 */
telemetryRouter.post('/ingest', (req: Request, res: Response): void => {
  const { nodeId, telemetryValue, payloadSizeKB, proof } = req.body;

  if (!nodeId || telemetryValue === undefined || !payloadSizeKB || !proof) {
    res.status(400).json({ error: 'Missing required parameters: nodeId, telemetryValue, payloadSizeKB, proof' });
    return;
  }

  // 1. Simulate mTLS validation check on client certificate
  const clientCertVerified = req.header('X-Client-Cert-Verified') === 'true' || true; // defaulted in dev
  if (!clientCertVerified) {
    res.status(403).json({ error: 'mTLS handshake failed: Unauthorized device certificate' });
    return;
  }

  // 2. Validate range proof using ZkVerifier
  const verification = ZkVerifier.verifyRangeProof(telemetryValue, {
    proofHash: proof.proofHash,
    commitment: proof.commitment,
    lowerBound: proof.lowerBound || 15.0,
    upperBound: proof.upperBound || 35.0
  });

  if (!verification.verified) {
    res.status(422).json({
      status: 'rejected',
      error: verification.error,
      gasBilledStroops: verification.gasSpentStroops
    });
    return;
  }

  // 3. Dynamic Tariff calculation on mock ledger
  const nodeEscrow = MOCK_LEDGER_STATE.nodes.get(nodeId);
  if (!nodeEscrow) {
    res.status(404).json({ error: `No active escrow contract registered for node ${nodeId}` });
    return;
  }

  const baseRate = MOCK_LEDGER_STATE.activeTariff.baseRate;
  const footprintRate = payloadSizeKB * MOCK_LEDGER_STATE.activeTariff.sizeRateKB;
  const gasBuffer = MOCK_LEDGER_STATE.activeTariff.gasBuffer;
  const totalCost = baseRate + footprintRate + gasBuffer;

  if (nodeEscrow.balance < totalCost) {
    res.status(402).json({
      status: 'failed',
      error: `Stellar Soroban transaction aborted: Escrow balance depleted for ${nodeId}`
    });
    return;
  }

  // 4. Update ledger balance
  nodeEscrow.balance -= totalCost;

  res.status(200).json({
    status: 'success',
    txHash: `0x${crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : 'f4a81c00d8312e9b08f42da18'}`,
    nodeId,
    billedXlm: totalCost,
    remainingEscrowBalance: nodeEscrow.balance,
    gasSpentStroops: verification.gasSpentStroops
  });
});
