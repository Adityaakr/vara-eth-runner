# Preconf Lab — Roadmap (self-generated task queue)

Each milestone is a vertical slice with a done-signal. Order is dependency order.

| # | Goal | Files | Acceptance | Proof | Risk |
|---|------|-------|------------|-------|------|
| 1 | Stack + program round-trip | `run/start-node.sh`, `orderbook/` (Sails 2.0.0 ethexe), `run/deploy.sh` | gtest green for place/match/cancel; program uploaded + created with executable balance; one injected `place` returns a Promise receipt with a decodable u64 id | `cargo test` in orderbook; `ethexe tx send-message --injected --watch` prints reply | sails 2.0.0 + wasm32v1-none build; executable balance too low |
| 2 | Lab-server engine, both write paths | `lab-server/src/{chain,sails,engine}.ts`, vitest | `place()` via injected and via L1 `Mirror.sendMessage`; each write record has t_submit, t_preconf (receipt), t_l1_seen; pre-confirmed book view from `calculateReplyForHandle` | vitest against live stack: 1 order each path, both appear in preconf view | @vara-eth/api legacy format vs node; sails-js header encoding |
| 3 | Committed view from L1 logs | `lab-server/src/committed.ts`, ABI from `cargo sails sol` | committed book == preconf book after commit; committed lags by ≥1 block; divergence window measured per write | vitest: place → preconf shows it → committed shows it later; assert ordering of timestamps | eth-event log decoding (topics/abi) |
| 4 | Latency benchmark | `lab-server/src/bench.ts` | N=30 per path; p50/p95 for submit→preconf, submit→committed, preconf→committed; JSON + markdown report in `reports/` | `npm run bench` writes report; numbers non-degenerate | validator rate limits; queue backlog |
| 5 | Reorg matrix | `lab-server/src/reorg.ts`, `run/start-node.sh --quarantine N` | For quarantine ∈ {0,4}, depth ∈ {1,3,6}: record whether commitments continue, whether preconfirmed orders survive in committed view, purge reasons of injected txs referencing orphaned blocks | `npm run reorg-matrix` writes `reports/reorg-matrix.md` | node restart per cell (~10s); Anvil reorg semantics |
| 6 | Two-pane UI | `lab-ui/` (Vite+React+TS, viem types), WS client | live panes, per-write timeline bars, stats, buttons: place (injected/L1), reorg(depth) | manual run + screenshot; smoke test that WS snapshot renders | none major |
