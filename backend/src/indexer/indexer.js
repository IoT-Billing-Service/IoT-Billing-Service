import { Server } from '@stellar/stellar-sdk/rpc';
import { scvalToBigInt, scvalToString, unwrapVec } from './decode.js';

const METER_TOPIC = 'meter';

/**
 * Soroban RPC event poller.
 *
 * Polls `getEvents` for the deployed contract and forwards decoded `meter`
 * billing events to the cache layer. Filtering on the leading topic is done
 * application-side because the public testnet RPC only matches full topic
 * lists, and the device address (second topic) varies per event.
 */
export class EventIndexer {
  constructor({ rpcUrl, contractId, storage, pollIntervalMs, onEvent }) {
    this.rpc = new Server(rpcUrl);
    this.contractId = contractId;
    this.storage = storage;
    this.pollIntervalMs = pollIntervalMs;
    this.onEvent = onEvent || (() => {});
    this.timer = null;
    this.running = false;
    this.cursor = null;
  }

  start() {
    if (!this.contractId) {
      console.warn('[indexer] CONTRACT_ID not set; indexer idle.');
      return this;
    }
    this.running = true;
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    console.log(
      `[indexer] polling ${this.contractId} every ${this.pollIntervalMs}ms`,
    );
    this.poll();
    return this;
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
  }

  async poll() {
    try {
      const res = await this.rpc.getEvents({
        startLedger: this.storage.getLastLedger() + 1,
        filters: [
          {
            type: 'contract',
            contractIds: [this.contractId],
          },
        ],
        limit: 200,
      });

      for (const event of res.events) {
        await this.handleEvent(event);
      }

      if (res.latestLedger > this.storage.getLastLedger()) {
        this.storage.setLastLedger(res.latestLedger);
      }
    } catch (err) {
      console.error('[indexer] poll failed:', err.message);
    }
  }

  async handleEvent(event) {
    // Topics: [Symbol("meter"), device_id]
    const topics = (event.topic ?? []).map(scvalToString);
    if (topics[0] !== METER_TOPIC) {
      return; // not a billing event
    }
    const deviceId = topics[1] ?? null;

    // Data: (delta_units, total_cost, ledger_ts)
    const data = unwrapVec(event.value) ?? [];
    const [deltaUnits, cost, ts] = data;

    const row = {
      topic: METER_TOPIC,
      event_id: String(event.id),
      contract_id: this.contractId,
      ledger: Number(event.ledger),
      device_id: deviceId ? String(deviceId) : null,
      operator: null,
      units: deltaUnits ? scvalToBigInt(deltaUnits) : 0n,
      rate_per_unit: 0n,
      cost: cost ? scvalToBigInt(cost) : 0n,
      balance_after: null,
      seq: null,
      ledger_ts: ts ? Number(scvalToBigInt(ts)) : null,
      emitted_at: new Date().toISOString(),
      raw: JSON.stringify(
        event,
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      ),
    };

    this.storage.ingest(row);
    this.onEvent(row);
  }
}