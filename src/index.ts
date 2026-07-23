/**
 * IoT Billing Blockchain Transaction Explorer
 * 
 * Entry point for the explorer service.
 */

import { createExplorer } from './explorer.js';
import { startServer } from './api.js';

async function main() {
  const verifierKey = process.env.VERIFIER_KEY || 'default-verifier';
  const port = Number(process.env.PORT || 3000);

  const explorer = createExplorer(verifierKey);
  const server = await startServer(explorer, port);

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    await server.close();
    process.exit(0);
  });
}

main().catch(console.error);