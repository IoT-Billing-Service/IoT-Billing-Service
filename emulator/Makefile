.PHONY: help run-solar run-meter test-all clean

help:
	@echo "IoT Billing — Hardware Emulator"
	@echo
	@echo "Targets:"
	@echo "  run-solar   Start Solar Inverter emulation (100ms telemetry interval)"
	@echo "  run-meter   Start Smart Utility Meter emulation (kWh tick mode)"
	@echo "  test-all    Run local end-to-end integration test"
	@echo "  clean       Remove emulator artifacts (sessions, logs, db)"

run-solar:
	@echo "Starting Solar Inverter Emulation (100ms telemetry interval)..."
	python3 client.py --type solar --rate 5 --device-key test_key_1 --resolution 0.001

run-meter:
	@echo "Starting Smart Utility Meter Emulation (kWh tick mode)..."
	python3 client.py --type meter --rate 1 --device-key test_key_2 --resolution 1.0

test-all:
	@echo "Running local end-to-end integration test..."
	./scripts/test_e2e.sh

clean:
	@echo "Cleaning emulator artifacts..."
	rm -rf .emulator_sessions .emulator.log .emulator.db
	@echo "Done."