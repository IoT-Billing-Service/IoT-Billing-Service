import fastify from 'fastify';
import nacl from 'tweetnacl';

export const buildMockServer = () => {
  const app = fastify({ logger: false });

  // Endpoint imitating Soroban RPC
  app.post('/transactions', async (request, reply) => {
    try {
      const body = request.body as { tx: string };
      if (!body || !body.tx) {
        return reply.status(400).send({ error: 'Missing tx envelope' });
      }

      // Parse the envelope
      const envelope = JSON.parse(body.tx);
      const { payload, signature, publicKey } = envelope;

      if (!payload || !signature || !publicKey) {
        return reply.status(400).send({ error: 'Invalid envelope structure' });
      }

      // Cryptographically verify the signature
      const payloadBytes = new TextEncoder().encode(payload);
      const signatureBytes = Buffer.from(signature, 'hex');
      const publicKeyBytes = Buffer.from(publicKey, 'hex');

      const isValid = nacl.sign.detached.verify(payloadBytes, signatureBytes, publicKeyBytes);
      if (!isValid) {
        return reply.status(401).send({ error: 'Cryptographic verification failed: invalid signature' });
      }

      // Parse payload to grab seq num (for simulation realism)
      const parsedPayload = JSON.parse(payload);
      if (typeof parsedPayload.sequenceNumber !== 'number') {
        return reply.status(400).send({ error: 'tx_bad_seq' });
      }

      // Simulate blockchain latency (e.g. 50ms)
      const latencyMs = parseInt(process.env.MOCK_LATENCY_MS || '50', 10);
      if (latencyMs > 0) {
        await new Promise((r) => setTimeout(r, latencyMs));
      }

      const txHash = Buffer.from(nacl.randomBytes(32)).toString('hex');
      
      return reply.send({
        hash: txHash,
        status: 'SUCCESS',
      });
    } catch (err) {
      return reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  return app;
};

// If run directly (not imported as a module for tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.PORT || '8080', 10);
  const app = buildMockServer();
  
  app.listen({ port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Mock Soroban RPC listening at ${address}`);
  });
}
