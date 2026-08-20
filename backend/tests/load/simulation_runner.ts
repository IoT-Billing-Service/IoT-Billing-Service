import { SorobanRpcClient } from '../../src/core/blockchain/rpc_client.js';
import { NoncePool } from '../../src/core/blockchain/nonce_pool.js';
import { TransactionManager } from '../../src/core/blockchain/tx_manager.js';

class MockNoncePool extends NoncePool {
  private seq = 1;
  async acquire(workerId: string): Promise<number> {
    return this.seq++;
  }
  async release(workerId: string): Promise<void> {}
  async synchronize(): Promise<void> {}
}

const runSimulation = async (mode: string, ratePerSec: number, durationSec: number) => {
  const MOCK_RPC_URL = process.env.MOCK_RPC_URL || 'http://127.0.0.1:8080';
  console.log(`Starting simulation: ${mode} at ${ratePerSec} tx/s for ${durationSec}s`);

  const rpcClient = new SorobanRpcClient(MOCK_RPC_URL);
  const noncePool = new MockNoncePool();
  const txManager = new TransactionManager(rpcClient, noncePool);

  const totalTxs = ratePerSec * durationSec;
  const latencies: number[] = [];

  const start = Date.now();
  let submitted = 0;

  // Run a loop pushing batches every 100ms
  const batchIntervalMs = 100;
  const txPerBatch = Math.ceil(ratePerSec / (1000 / batchIntervalMs));

  return new Promise<void>((resolve, reject) => {
    const interval = setInterval(async () => {
      const batchPromises: Promise<void>[] = [];

      for (let i = 0; i < txPerBatch; i++) {
        if (submitted >= totalTxs) break;
        submitted++;
        const txStart = Date.now();
        batchPromises.push(
          txManager.submitChargeUsage('worker-1', `device-${submitted}`, 100n, 'contract_xyz')
            .then((res) => {
              latencies.push(Date.now() - txStart);
              if (res.status !== 'submitted') {
                console.error(`Tx failed: ${res.error}`);
              }
            })
            .catch((e) => {
              console.error(`Submission error: ${e.message}`);
            })
        );
      }

      if (submitted >= totalTxs) {
        clearInterval(interval);
        // Wait for all to finish
        await Promise.allSettled(batchPromises);

        const end = Date.now();
        console.log(`Simulation finished in ${end - start}ms`);

        if (latencies.length === 0) {
          console.error("No transactions succeeded.");
          return reject(new Error("No transactions succeeded"));
        }

        latencies.sort((a, b) => a - b);
        const p50 = latencies[Math.floor(latencies.length * 0.5)];
        const p90 = latencies[Math.floor(latencies.length * 0.9)];
        const p99 = latencies[Math.floor(latencies.length * 0.99)];

        console.log(`\nMetrics:
          Total Txs: ${latencies.length}
          P50: ${p50}ms
          P90: ${p90}ms
          P99: ${p99}ms
        `);

        if (p99 > 200) {
          console.error('❌ Failed: P99 latency exceeded 200ms target.');
          process.exit(1);
        } else {
          console.log('✅ Success: P99 latency is well within 200ms.');
          resolve();
        }
      } else {
        // Fire and forget batch
        Promise.allSettled(batchPromises).catch(() => {});
      }
    }, batchIntervalMs);
  });
};

const args = process.argv.slice(2);
const mode = args[0] || 'steady_state';
const rate = parseInt(args[1] || '100', 10);
const duration = parseInt(args[2] || '10', 10);

runSimulation(mode, rate, duration).then(() => {
  process.exit(0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
