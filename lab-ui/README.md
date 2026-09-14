# lab-ui

Vite + React telemetry page for the lab. Connects to `ws://127.0.0.1:8787` (override with `VITE_LAB_WS`).

- KPI ribbon: median and p95 pre-confirmation, fastest observed, throughput, totals, settled.
- 180 s area chart of pre-confirmed tx/s with the per-second median latency line; latency distribution histogram.
- Transaction tape with inline latency bars; settlement per block; settlement and safety metrics.
- Wallet drawer: WebAuthn passkey → PRF secret → HKDF → secp256k1 key in the browser; orders are signed locally and
  relayed by the server. Needs Chrome 116+ or Safari 18+ on `http://localhost`.
- Collapsed section: Ethereum-transaction comparison, forced reorg with anchor warning, both order-book views.

```bash
npm run dev            # http://localhost:5173
npm run build
npm run render-check   # server-renders LabView with a live snapshot and asserts key content (no browser)
```
