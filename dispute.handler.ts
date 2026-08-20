import { FastifyInstance } from 'fastify';
import { Server } from '@stellar/stellar-sdk';

const server = new Server(process.env.STELLAR_RPC_URL!);

export async function registerDisputeRoutes(app: FastifyInstance) {
  app.get('/api/billing/dispute/:txHash', async (req, reply) => {
    const { txHash } = req.params as { txHash: string };
    
    try {
      const tx = await server.getTransaction(txHash);
      if (!tx.successful) return reply.status(404).send({ error: "Tx not found" });

      return reply.send({
        version: "1.0",
        type: "IOT_BILLING_DISPUTE_EVIDENCE",
        generatedAt: new Date().toISOString(),
        compliance: ["PCI-DSS", "SOC2"],
        evidence: {
          stellarTxHash: txHash,
          ledger: tx.ledger,
          createdAt: tx.created_at,
          signatures: tx.signatures,
        }
      });
    } catch (error) {
      return reply.status(500).send({ error: "Failed to fetch evidence" });
    }
  });
}
