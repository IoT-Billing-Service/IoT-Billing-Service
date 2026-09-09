#!/usr/bin/env python3
"""IoT Billing — peripheral hardware client emulator.

Emulates an ed25519-enabled device: generates realistic sensor telemetry,
locally accumulates meter ticks, signs each `delta_units` reading payload with
its hardware ed25519 key (matching the on-chain `submit_reading` message
scheme), and streams it to the backend gateway.

Payloads are signed as
    ed25519_sign( "iot-billing-v1" || device_pubkey || seq(be64)
                  || delta_units(be64) || timestamp_ms(be64) )
which is exactly what `contracts/src/storage.rs::verify_signature` checks.

Usage:
    python3 client.py --type solar --rate 5 --device-key test_key_1
    python3 client.py --type meter --rate 1 --device-key test_key_2
"""

from __future__ import annotations

import argparse
import json
import random
import time
import urllib.request
from dataclasses import dataclass, field

import nacl.signing

# Must match `storage::SIGNING_DOMAIN` in the contract.
SIGNING_DOMAIN = b"iot-billing-v1"


@dataclass
class DeviceProfile:
    device_type: str
    interval_ms: int
    base_delta: float
    jitter: float
    resolution: float


PROFILES = {
    "solar": DeviceProfile("solar", 100, 0.05, 0.03, 0.001),
    "meter": DeviceProfile("meter", 1000, 0.001, 0.0005, 1.0),
    "generic": DeviceProfile("generic", 500, 1.0, 0.5, 1.0),
}


def compute_delta(profile: DeviceProfile, t: float) -> float:
    """Realistic sinusoidal telemetry with random jitter."""
    envelope = (1.0 + 0.5 * __import__("math").sin(t / 10.0))
    return max(
        profile.resolution,
        profile.base_delta * envelope + random.uniform(-profile.jitter, profile.jitter),
    )


def sign_payload(sk: nacl.signing.SigningKey, seq: int, delta_units: int, ts: int) -> tuple[bytes, str]:
    """Sign a reading with the device's real ed25519 hardware key.

    Returns `(device_pubkey_bytes, hex_signature)`.
    """
    pubkey = sk.verify_key.encode()
    message = (
        SIGNING_DOMAIN + pubkey + seq.to_bytes(8, "big") +
        delta_units.to_bytes(8, "big") + ts.to_bytes(8, "big")
    )
    sig = sk.sign(message).signature
    return pubkey, sig.hex()


@dataclass
class EmulatedDevice:
    profile: DeviceProfile
    device_key: str
    endpoint: str
    signer: nacl.signing.SigningKey = field(
        default_factory=nacl.signing.SigningKey.generate
    )
    seq: int = 0
    cumulative: float = 0.0
    started: float = field(default_factory=time.time)

    def _accumulated_ticks(self, value: float) -> int:
        resolution = self.profile.resolution
        ticks = int(value / resolution)
        delta_units = max(1, ticks)
        return delta_units

    def emit(self) -> dict:
        value = compute_delta(self.profile, time.time() - self.started)
        self.cumulative += value
        delta_units = self._accumulated_ticks(value)
        ts = int(time.time() * 1000)
        self.seq += 1
        pubkey, signature = sign_payload(self.signer, self.seq, delta_units, ts)

        return {
            "device_id": self.device_key,
            "device_pubkey": pubkey.hex(),
            "device_type": self.profile.device_type,
            "seq": self.seq,
            "delta_units": delta_units,
            "cumulative_units": int(self.cumulative),
            "timestamp_ms": ts,
            "signature": signature,
        }

    def stream(self):
        print(
            f"[client] {self.profile.device_type} device '{self.device_key}' "
            f"streaming every {self.profile.interval_ms}ms"
        )
        try:
            while True:
                payload = self.emit()
                self.deliver(payload)
                time.sleep(self.profile.interval_ms / 1000.0)
        except KeyboardInterrupt:
            print("\n[client] stopped")

    def deliver(self, payload: dict):
        if not self.endpoint:
            print(json.dumps(payload))
            return
        req = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                print(f"[client] POST {self.endpoint} -> {resp.status}")
        except Exception as err:  # noqa: BLE001
            print(f"[client] delivery failed: {err}")


def main():
    parser = argparse.ArgumentParser(description="IoT hardware emulator")
    parser.add_argument("--type", choices=PROFILES.keys(), default="solar")
    parser.add_argument("--rate", type=float, default=1.0)
    parser.add_argument("--device-key", required=True)
    parser.add_argument("--interval-ms", type=int, default=None)
    parser.add_argument("--resolution", type=float, default=None)
    parser.add_argument("--endpoint", default=None, help="POST target (http://…/api/readings)")
    args = parser.parse_args()

    profile = PROFILES[args.type]
    if args.interval_ms:
        profile.interval_ms = args.interval_ms
    if args.resolution:
        profile.resolution = args.resolution
    profile.base_delta = args.rate

    EmulatedDevice(profile, args.device_key, args.endpoint).stream()


if __name__ == "__main__":
    main()