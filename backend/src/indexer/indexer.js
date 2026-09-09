import { Server } from '@stellar/stellar-sdk/rpc';
import { scvalToBigInt, scvalToString } from './decode.js';

/**
 * Soroban RPC event poller.
 *
 * Subscribes to `getEvents` filtered on the deployed contract's
 * `MeterBilled` / `FundsDeposited` topics and forwards decoded rows to the
 * cache layer.
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
            topics: [[{ type: 'scv_symbol', value: 'MeterBilled' }]],
          },
        ],
        pagination: { limit: 200 },
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
    // Topic[1..]: device_id, operator, units, rate, cost, balance_after, seq
    const [deviceId_t, operator_t, units_t, rate_t, cost_t, balance_t, seq_t] =
      event.topic ?? [];

    const row = {
      topic: event.type,
      event_id: String(event.id),
      contract_id: this.contractId,
      ledger: Number(event.ledger),
      device_id: deviceId_t ? scvalToString(deviceId_t) : null,
      operator: operator_t ? scvalToString(operator_t) : null,
      units: units_t ? scvalToBigInt(units_t) : 0n,
      rate_per_unit: rate_t ? scvalToBigInt(rate_t) : 0n,
      cost: cost_t ? scvalToBigInt(cost_t) : 0n,
      balance_after: balance_t ? scvalToBigInt(balance_t) : 0n,
      seq: seq_t ? scvalToBigInt(seq_t) : 0n,
      contract_event: event.value,
      emitted_at: new Date().toISOString(),
      raw: JSON.stringify(event),
    };

    this.storage.ingest(row);
    this.onEvent(row);
  }
}
