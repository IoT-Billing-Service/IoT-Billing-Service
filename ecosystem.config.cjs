/**
 * PM2 process definitions for the IoT billing stack (dev/staging demo).
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 logs
 *
 * - backend: event indexer + REST/WS gateway
 * - emulator: an example device relaying signed telemetry to the gateway
 *
 * The emulator app is disabled by default so operators can choose which
 * devices to simulate.
 */
module.exports = {
  apps: [
    {
      name: 'iot-billing-backend',
      cwd: './backend',
      script: 'src/index.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      time: true,
      out_file: '../logs/backend.out.log',
      error_file: '../logs/backend.err.log',
    },
    {
      name: 'iot-device-emulator',
      cwd: './emulator',
      script: 'client.py',
      interpreter: 'python3',
      args: '--type meter --device-key demo_meter --endpoint http://127.0.0.1:8080/api/readings',
      autorestart: true,
      time: true,
      out_file: '../logs/emulator.out.log',
      error_file: '../logs/emulator.err.log',
      // Disabled by default; enable with `pm2 start ecosystem.config.cjs --only iot-device-emulator`
      autostart: false,
    },
  ],
};