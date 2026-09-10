import { Server } from '@stellar/stellar-sdk/rpc';
import { scvalToBigInt, scvalToString, unwrapVec } from './decode.js';

const METER_TOPIC = 'meter';
const PAGE_LIMIT = 200;

/**
 * Soroban RPC event poller.
 *
 * Polls `getEvents` for the deployed contract and forwards decoded `meter`
 * billing events to the cache layer. Filtering on the leading topic is done
 * application-side because the public testnet RPC only matches full topic
 * lists, and the device address (second topic) varies per event.
 *
 * Pagination: when a full page is returned there may be more events at the
 * same or subsequent ledgers. The poller loops with the returned cursor until
 * fewer than PAGE_LIMIT events come back, only then advancing the persisted
 * ledger watermark.
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
      let cursor = null;
      let startLedger = (await this.storage.getLastLedger()) + 1;
      let lastProcessedLedger = await this.storage.getLastLedger();

      // Fetch all pages before advancing the watermark.
      while (true) {
        const params = {
          filters: [
            {
              type: 'contract',
              contractIds: [this.contractId],
            },
          ],
          limit: PAGE_LIMIT,
        };
        if (cursor) {
          params.cursor = cursor;
        } else {
          params.startLedger = startLedger;
        }

        const res = await this.rpc.getEvents(params);

        for (const event of res.events) {
          await this.handleEvent(event);
          const ledger = Number(event.ledger);
          if (ledger > lastProcessedLedger) {
            lastProcessedLedger = ledger;
          }
        }

        // If we got fewer than a full page or no cursor, we're done.
        if (res.events.length < PAGE_LIMIT || !res.cursor) {
          // Advance watermark: if we processed any events use the last ledger,
          // otherwise jump to latestLedger to avoid re-fetching an empty range.
          const lastLedger = await this.storage.getLastLedger();
          const newWatermark =
            lastProcessedLedger > lastLedger
              ? lastProcessedLedger
              : res.latestLedger;
          if (newWatermark > lastLedger) {
            await this.storage.setLastLedger(newWatermark);
          }
          break;
        }

        cursor = res.cursor;
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

    // Data: (delta_units, total_cost, balance_after, seq, ledger_ts)
    const data = unwrapVec(event.value) ?? [];
    const [deltaUnits, cost, balanceAfter, seq, ts] = data;

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
      balance_after: balanceAfter ? scvalToBigInt(balanceAfter) : null,
      seq: seq ? Number(scvalToBigInt(seq)) : null,
      ledger_ts: ts ? Number(scvalToBigInt(ts)) : null,
      emitted_at: new Date().toISOString(),
      raw: JSON.stringify(event, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    };

    await this.storage.ingest(row);
    this.onEvent(row);
  }
}
