import crypto from 'node:crypto';
import { Router } from 'express';
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { Server as SorobanRpc } from '@stellar/stellar-sdk/rpc';

// Must match `storage::SIGNING_DOMAIN` in the contract.
const SIGNING_DOMAIN = Buffer.from('iot-billing-v1', 'utf8');

const u64be = (n) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(n));
  return buf;
};

/**
 * Verify a device's ed25519 signature over the on-chain payload:
 *   SIGNING_DOMAIN || device_pubkey || seq(be64) || delta_units(be64) || timestamp_ms(be64)
 */
export function verifyDeviceSignature({
  devicePubkeyHex,
  seq,
  deltaUnits,
  timestampMs,
  signatureHex,
}) {
  const pubkey = Buffer.from(devicePubkeyHex, 'hex');
  if (pubkey.length !== 32) return false;
  const signature = Buffer.from(signatureHex, 'hex');
  if (signature.length !== 64) return false;
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: pubkey.toString('base64url') },
      format: 'jwk',
    });
  } catch {
    return false;
  }
  const message = Buffer.concat([
    SIGNING_DOMAIN,
    pubkey,
    u64be(seq),
    u64be(deltaUnits),
    u64be(timestampMs),
  ]);
  return crypto.verify(null, message, publicKey, signature);
}

function parseU64(v, name) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return n;
}

/** @returns {import('@stellar/stellar-sdk/rpc').Server|null} lazily-created RPC client */
export function createReadingsRouter({ config, storage }) {
  const router = Router();

  router.post('/api/readings', async (req, res) => {
    const {
      device_pubkey: devicePubkeyHex,
      seq,
      delta_units: deltaUnits,
      timestamp_ms: timestampMs,
      signature: signatureHex,
    } = req.body ?? {};

    const missing = [
      'device_pubkey',
      'seq',
      'delta_units',
      'timestamp_ms',
      'signature',
    ]
      .filter((k) => req.body?.[k] === undefined)
      .join(', ');
    if (missing) {
      return res.status(400).json({ error: `missing fields: ${missing}` });
    }

    let seqN;
    let deltaN;
    let tsN;
    try {
      seqN = parseU64(seq, 'seq');
      deltaN = parseU64(deltaUnits, 'delta_units');
      tsN = parseU64(timestampMs, 'timestamp_ms');
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const valid = verifyDeviceSignature({
      devicePubkeyHex,
      seq: seqN,
      deltaUnits: deltaN,
      timestampMs: tsN,
      signatureHex,
    });
    if (!valid) {
      return res.status(401).json({ error: 'invalid device signature' });
    }

    // Derive the device's on-chain account from its ed25519 public key, exactly
    // as it was (or must be) registered on the contract.
    let deviceAddress;
    try {
      const pubkey = Buffer.from(devicePubkeyHex, 'hex');
      deviceAddress = StrKey.encodeEd25519PublicKey(pubkey);
    } catch {
      return res.status(400).json({ error: 'invalid device_pubkey' });
    }

    // Relay to the contract when a relayer keypair + contract are configured.
    if (config.contractId && config.relayerSecret) {
      try {
        const txHash = await relayReading({
          rpcUrl: config.sorobanRpcUrl,
          networkPassphrase: config.networkPassphrase,
          contractId: config.contractId,
          relayerSecret: config.relayerSecret,
          deviceAddress,
          sigHex: signatureHex,
          deltaUnits: deltaN,
          seq: seqN,
          timestampMs: tsN,
        });
        await storage.recordPendingReading({
          device_id: deviceAddress,
          device_pubkey: devicePubkeyHex,
          seq: seqN,
          delta_units: deltaN,
          timestamp_ms: tsN,
          tx_hash: txHash,
        });
        return res.json({
          ok: true,
          tx_hash: txHash,
          device_id: deviceAddress,
        });
      } catch (e) {
        console.error('[gateway] relay failed:', e.message);
        return res.status(502).json({ error: `relay failed: ${e.message}` });
      }
    }

    await storage.recordPendingReading({
      device_id: deviceAddress,
      device_pubkey: devicePubkeyHex,
      seq: seqN,
      delta_units: deltaN,
      timestamp_ms: tsN,
      tx_hash: null,
    });
    return res.status(202).json({
      ok: true,
      relayed: false,
      device_id: deviceAddress,
      note: 'accepted; no relayer configured — not submitted on-chain',
    });
  });

  return router;
}

/**
 * Submit a Soroban InvokeHostFunction transaction for `submit_reading`
 * signed by the relayer keypair.
 */
export async function relayReading({
  rpcUrl,
  networkPassphrase,
  contractId,
  relayerSecret,
  deviceAddress,
  sigHex,
  deltaUnits,
  seq,
  timestampMs,
}) {
  const rpc = new SorobanRpc(rpcUrl);
  const relayer = Keypair.fromSecret(relayerSecret);
  const contract = new Contract(contractId);

  const sig = Buffer.from(sigHex, 'hex');
  const args = [
    new Address(deviceAddress).toScVal(),
    nativeToScVal(deltaUnits, { type: 'u64' }),
    nativeToScVal(seq, { type: 'u64' }),
    nativeToScVal(timestampMs, { type: 'u64' }),
    nativeToScVal(sig, { type: 'bytes' }),
  ];

  const account = await rpc.getAccount(relayer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .setTimeout(30)
    .addOperation(contract.call('submit_reading', ...args))
    .build();

  // Simulate to gather resource fees + Soroban preflight before submission.
  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(relayer);
  const res = await rpc.sendTransaction(prepared);

  if (res.status === 'PENDING' || res.status === 'SUCCESS') {
    return res.hash;
  }
  if (res.status === 'ERROR') {
    const codes = [];
    for (const info of res.errorResult?.result?.results ?? []) {
      if (info.hasOtherError && info.otherError) {
        codes.push(info.otherError.toXDR('base64'));
      }
    }
    throw new Error(`contract rejected: ${codes.join(' / ') || res.status}`);
  }
  throw new Error(`sendTransaction status=${res.status}`);
}

export default createReadingsRouter;
