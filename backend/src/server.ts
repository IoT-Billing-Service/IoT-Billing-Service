import express from 'express';
import dotenv from 'dotenv';
import { telemetryRouter } from './routes/telemetry';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Parse incoming payloads
app.use(express.json());

// Main Ingestion API Router
app.use('/api/telemetry', telemetryRouter);

// System Health Checks
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    systemTime: new Date().toISOString(),
    uptimeSeconds: process.uptime(),
    sorobanNodeConnection: 'active',
  });
});

app.listen(PORT, () => {
  console.log(`[IoT-Billing-Backend] Live and listening on port ${PORT}`);
});
