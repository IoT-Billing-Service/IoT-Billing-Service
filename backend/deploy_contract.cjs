const { readFileSync } = require('fs');
const { 
  Keypair, 
  rpc,
  TransactionBuilder, 
  Networks,
  xdr,
  Operation,
  Asset,
  BASE_FEE,
} = require('@stellar/stellar-sdk');

async function main() {
  const wasmPath = process.argv[2];
  const wasm = readFileSync(wasmPath);
  
  const server = new rpc.Server('http://localhost:8000/soroban/rpc', { allowHttp: true });
  
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    console.error('ADMIN_SECRET env var required');
    process.exit(1);
  }
  
  const adminKeypair = Keypair.fromSecret(adminSecret);
  const adminPubkey = adminKeypair.publicKey();
  
  console.log('Admin public key:', adminPubkey);
  console.log('WASM size:', wasm.length, 'bytes');
  
  // Get account
  const account = await server.getAccount(adminPubkey);
  console.log('Account sequence:', account.sequenceNumber);
  
  // Create the upload contract wasm host function
  const hostFunction = xdr.HostFunction.hostFunctionTypeUploadContractWasm(
    xdr.UploadContractWasmHostFunction.fromXDR(wasm)
  );
  
  // Build the operation
  const op = Operation.invokeHostFunction({
    func: hostFunction,
    auth: [],
  });
  
  // Build transaction
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.STANDALONE,
  })
    .addOperation(op)
    .setTimeout(300)
    .build();
  
  console.log('Simulating transaction...');
  const simResp = await server.simulateTransaction(tx);
  
  if (simResp.error) {
    console.error('Simulation error:', JSON.stringify(simResp.error, null, 2));
    return;
  }
  
  console.log('Simulation succeeded!');
  console.log('Result keys:', Object.keys(simResp).join(', '));
  if (simResp.result) {
    console.log('Result:', JSON.stringify(simResp.result, null, 2).substring(0, 800));
  }
  if (simResp.results) {
    console.log('Results:', JSON.stringify(simResp.results, null, 2).substring(0, 800));
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  if (e.stack) console.error(e.stack.substring(0, 800));
  process.exit(1);
});
