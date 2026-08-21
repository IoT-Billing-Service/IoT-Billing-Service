# Real-Time Usage Dashboard

## Data path

Only telemetry that has passed the ingestion signature and proof checks is published to `TelemetryStreamBus`. The authenticated WebSocket endpoint `/api/billing/stream` subscribes to that bus and sends the validated event to dashboard clients. A client may pass `deviceId` to receive one device, or omit it for the tenant's wildcard stream.

WebSocket frames are JSON:

```json
{
  "serverTs": "2026-08-20T12:00:00.000Z",
  "deviceId": "MTR-001",
  "metrics": { "powerUsage": 12.5 },
  "recordsWritten": 1
}
```

The browser supplies the short-lived session JWT as the `token` query parameter because browser WebSocket clients cannot set an `Authorization` header. Do not log query strings. The server rejects missing, forged, and expired tokens with close code `4001`.

## Reliability and performance

- The ingestion path publishes synchronously after persistence and never waits for a WebSocket client.
- Each client drops frames when its socket write buffer exceeds 1 MiB; this bounds memory and preserves the billing latency budget.
- Clients send `{ "type": "ping" }` and expect `{ "type": "pong" }`.
- The server sends a `token_expiring` control frame 120 seconds before expiry. The frontend refreshes/reconnects using its existing session lifecycle.
- Reconnect delays are capped at 30 seconds. Dashboard state is updated from the next validated event; historical data remains an HTTP/query concern.

## Deployment

The reverse proxy or load balancer must forward HTTP Upgrade requests to the backend and use a long idle timeout. For Nginx, the relevant location needs `proxy_http_version 1.1`, `proxy_set_header Upgrade $http_upgrade`, and `proxy_set_header Connection "upgrade"`. Use sticky routing or a shared pub/sub bridge when multiple backend replicas must receive the same stream; the current in-process bus is replica-local.

## Monitoring

`GET /telemetry/stream/stats` reports the existing SSE counters and:

- `websocket.connections`: active WebSocket clients
- `websocket.delivered`: frames written to clients
- `websocket.dropped`: frames skipped because of backpressure
- `websocket.rejected`: failed WebSocket authentication attempts

Alert on sustained growth in `dropped`, unexpected `rejected` spikes, and `connections` approaching the deployment's connection limit. Correlate stream delivery latency with ingestion request P99 and keep the billing-operation P99 target below 200 ms. Do not include JWTs, raw signed payloads, or payment credentials in logs or telemetry labels.