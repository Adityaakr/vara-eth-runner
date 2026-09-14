# Changelog

## 2026-09-14

- Local Vara.eth stack: gear v2.0.0 ethexe dev node with embedded Anvil, verified-fresh restart script, multi-instance deploy.
- Sails 2.0 ethexe order-book program with sequence-stamped eth events; unit tests and gtest.
- Measurement engine: injected and L1 write paths on one clock, reorg-safe committed view from Mirror logs, benchmark, reorg matrix.
- Findings: ~500 preconf/s ceiling on one validator; reorg absorbed iff depth ≤ quarantine + 1; pre-confirmations keep flowing after a deeper reorg while nothing settles.
- Telemetry page with KPI ribbon, throughput/latency chart, latency histogram, tape, settlement, wallet drawer with WebAuthn passkey signing.
- Autopilot traffic generator with periodic surges.
