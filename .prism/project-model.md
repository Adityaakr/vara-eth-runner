# Preconf Lab — project model

## Invariants (cited)
- Node dev mode requires Foundry **1.7.0** exactly (`ethexe/service/src/lib.rs:187-199`); `foundryup --install 1.7.0`.
- Node dev mode needs `--validators-malachite-pub-keys` JSON `{addr: compressed pubkey}`; validator = Anvil #1 = `0x70997970c51812dc3a010c7d01b50e0d17dc79c8` → `0x02ba5734d8f7091719471e7f7ed6b9df170dc70cc661ca05e688601ad984f068b0`.
- `program_calculateReplyForHandle` ignores `at`; always latest computed MB (`ethexe/rpc/src/apis/program.rs:131`).
- Eth events reach L1 as raw `log1..4` on the Mirror during `performStateTransition` (`Mirror.sol:633-752`).
- Injected tx reference block must be within `VALIDITY_WINDOW=32` and on the current branch (`tx_validity.rs`).
- Reorg with quarantine 0 blocks batch commitments ("refusing to build batch") — observed 2026-09-14.
- `anvil_reorg` params are positional: `cast rpc anvil_reorg <depth> '[]'` (Foundry 1.7.0 `ReorgOptions` is a sequence).

- Program init on Vara.eth: `createProgram` only creates the Mirror; the first **L1** `sendMessage` must carry the constructor payload. Injected txs to an uninitialized program are dropped as `UninitializedDestination` (`ethexe/malachite/service/src/tx_validity.rs`). `Create()` payload = `0x474d0110` + 12 zero bytes.
- Injected txs that sit unincluded for `VALIDITY_WINDOW` (32 blocks) are purged as `Outdated` — a purge reason can mask a different root cause (check node log for `dropping injected tx — fails TxValidity`).
- sails-rs 2.0.0 ethexe: `u8` and `bool` are NOT usable in eth events / ethabi params (`u8: SolValue` unimplemented; `&bool: SolTypeValue` unimplemented). Use u32/u64.
- Sails header interface id is written as raw bytes (`sails-idl-meta/src/header.rs:95`), not little-endian; the vara-skills wire-format note saying "LE" is misleading.
- gtest `listen()` cannot decode eth-format events (topics+ABI); it hangs on `next()`. Assert eth events in unit tests (`emitter().take_events()` under `std`) or on L1 logs.
- Executable balance: `tx create --value 1000000000000000` = 1000 WVARA (12 decimals) is plenty for injected messages.

- @vara-eth/api 0.6.0-rc.0 vs node v2.0.0: node has no `version` RPC → lib picks legacy envelope `{recipient, tx}` (correct) AND legacy digest (wrong; node signs `to_hashable_bytes`, `ethexe/common/src/injected.rs:97`). Fix: override `_bytesBasedOnVersion` → `_hashableBytes` on the InjectedTx instance (`lab-server/src/engine.ts createInjectedTx`). Recipient zero address is what the Rust CLI sends.
- Measured 2026-09-14: injected submit→signed promise ≈ 4 ms on localhost; L1 submit→mined ≈ 1 block (Anvil 1 s), but viem receipt polling defaults to 4 s — set `pollingInterval` on the PublicClient.

- Committed view = replay of Mirror logs only (`lab-server/src/l1watch.ts`, reorg-safe by re-checking the last head hash each poll and rebuilding from genesis on mismatch). `Placed.qty` is the *remaining* qty, so L1 writes are attributed via the Mirror `Reply` log (replyTo == messageId), not by payload.
- viem returns checksummed addresses, sails-js lowercase: normalize before comparing views.
- Measured 2026-09-14 (quarantine 0, 1 s blocks): injected preconf ≈ 2–6 ms; injected→committed ≈ 1.3–2.0 s (≈5 blocks after the reference block); L1 mined ≈ 0.9 s, L1→committed ≈ 3.9 s (≈3 blocks after mined).

- REORG MATRIX (2026-09-14, reports/reorg-matrix-2026-09-14T06-19-06-193Z.md): reorg depth ≤ canonical-quarantine + post-quarantine-delay(1) is absorbed (q0:d1 ok, d2/d3/d6 stuck; q4:d1,d3 ok, d6 stuck). When stuck, the node logs "refusing to build batch" forever, previously committed orders whose commit txs were reorged away are NEVER re-committed, and injected txs STILL receive validator-signed promises in ms that never settle. A pre-confirmation is only as good as the validator's Ethereum anchor depth.

- Feedback round 1 (2026-09-14) fixed: watcher stop flag, TOCTOU in ingest (head hash checked before+after getLogs), RPC errors no longer counted as reorgs, rebuild clears every record's committed stamp (`uncommittedByReorg` counter), L1 tx signed before tSubmit, injected anchored at head (lib default is head−3), nearest-rank percentiles, exclusion counts in reports, WS server loopback-only + overlap guard, program capacity check moved before matching.
- Known limitations (accepted for a lab): resting-slot squatting DoS in the program (permissionless place, owner-only cancel, cap 256/side); reorg matrix is one trial per cell; committed stamps are observation times.

- LOAD (2026-09-14, M4-node laptop, single validator): CLI blast 200@16 → 306 preconf/s, p50 39 ms, min 3 ms; 1000@64 → 443/s, p50 106 ms, p95 162; 2000@128 → 286/s, p50 406 ms (queueing). Validator makes MBs continuously (~30 ms apart) when work is pending, not once per Ethereum block. Settlement ≈ 120 txs per 1 s Ethereum block. Injected per-MB limit is by bytes (`MAX_INJECTED_TRANSACTIONS_SIZE_PER_MB` = 127 KiB), not count.
- start-node.sh race: a restart that starts before the old Anvil frees :8545 makes the node attach to the OLD chain and later "refusing to build batch" with no reorg. Script now waits for ports and verifies anvil head < 60 and anvil's parent == node pid.
- Dashboard: the 250 ms `calculateReplyForHandle` poll competes with execution; paused during blasts.

- Passkey signing (2026-09-14): WebAuthn P-256 cannot produce the secp256k1/EIP-191 signature the validator recovers, so the PRF extension secret seeds a secp256k1 key via HKDF in the browser (`lab-ui/src/passkey.ts`); server `prepare` → browser signs `tx.hash` → server `submitSigned` uses a shim IMessageSigner. Verified headless with a fresh unfunded key: pre-confirmed in 2 ms (injected txs are paid by the program's executable balance).

- Autopilot (2026-09-14): `lab-server/src/traffic-cli.ts` token-bucket generator spawned by serve.ts; 20 tx/s steady gives p50 5–13 ms, min 1.9 ms, 0 failures. Records from children go into a 4000-entry ring; all-time totals are counters.

- THROUGHPUT CEILING (2026-09-14, fresh stack): ~470–500 preconf/s regardless of 1 vs 4 program instances or 1 vs 2 load processes → limit is the validator's MB pipeline, not WASM execution. Light load 2–20 ms; saturation p50 100–160 ms. 40K tx/s is not attainable on this setup; do not quote it.
- Load pattern bug: side must alternate PER program instance (one-sided instances hit the 256 cap and reject everything). Fixed in traffic-cli.ts and blast.ts.
- Sustained-load creep: each order emits 2 events; Ethereum settlement absorbs ~120 events per 1 s block, so above ~60 tx/s the unsettled backlog grows and p50 creeps (24→51 ms over 3.5 min at 60 tx/s). Autopilot default set to 25 tx/s + 250-tx surges every 75 s.
- Dashboard v4: Vara palette (mint #00e6b8 on green-black), sans text + mono numerals, KPI ribbon, area chart + latency histogram, tape with inline latency bars, wallet drawer (passkey), collapsed fault-injection section.

- NETWORK EMULATION (2026-09-14): `lab-server/src/netem.ts` WS proxy :9945 → :9944, order-preserving per direction, one-way = calibrated RTT/2 (live `system_chain` to wss://rpc.vara.network ≈ 164–181 ms from this machine) + N(0,4) jitter + 2% spikes. Result p50 208–219 ms, p95 250–320 ms, min 183 ms at 25 tx/s with surges. `ws` message buffers must be copied before delayed forwarding.
- Validator occasionally never delivers a promise (~0.5% under bursts, no node log); `sendAndWaitForReceipt` is now bounded by `LAB_RECEIPT_TIMEOUT_MS` (10 s) and counted as failed, otherwise every loop behind it hangs.

- ROOT CAUSE of validator slowdown (2026-09-14): `ethexe run --dev --tmp` persists every micro-block to RocksDB and never prunes: 64 GB after 41 min at 25 tx/s (31k MBs), 135% CPU, MB cadence 10 → 80 ms. 23 abandoned tmp stores held 145 GB. start-node.sh now deletes `$TMPDIR/ethexe*` on start; serve.ts recycles node+deploy every LAB_RECYCLE_MINUTES (10) or when validator-side p50 (measured − emulated wire) > LAB_RECYCLE_VALIDATOR_MS (60) for 30 s; autopilot default lowered to 12 tx/s, surges 120@12 every 90 s.

- Emulator lesson (2026-09-14): independent per-frame jitter can deliver the validator's subscription ack and its first notification back to back, and the JS client drops the notification (2–3% "no receipt"). Fix: never compress spacing between frames that arrived ≤ 40 ms apart, but do not tie distant frames or positive jitter ratchets the schedule (delays grow unbounded). Direct path: 0/400 failures; emulated after fix: 0/650.
- Recycle watch: 12 min at 12 tx/s, p50 182–192 ms throughout, scheduled recycle at 10 min took ~30 s, store 1.4 GB → reset. `LAB_REF_BLOCK_LAG` env exists but made no difference.

- ETHEXE LIMIT (2026-09-14): `MAX_OUTGOING_MESSAGES_PER_EXECUTION = 4` (`ethexe/runtime/common/src/lib.rs:114`); eth events count. A `place` that fills ≥4 makers panics with `OutgoingMessagesAmountLimitExceeded` (visible only with the `gstd-panic-message` feature, otherwise "panicked with '<unknown>'"). Program now caps fills at 3 per order (`MAX_FILLS_PER_ORDER`) and rests the remainder. Traffic generator cancels oldest resting orders above 24 per instance.

- Wallet Send (2026-09-14): `ledger/` program (transfer/faucet/balance_of, 1 event per call), deployed by `run/deploy-ledger.sh` → `run/ledger.addr`; server commands `balance`, `prepare{kind:transfer|faucet|place}`; engine `prepareCall`/`queryRaw`; ledger records are `untracked` (L1 watcher follows only the order book). sails-js accepts a 20-byte hex for the `Address(H160)` struct.

- Recycle trigger changed (2026-09-14): latency creep could not distinguish queueing under load from store bloat and looped at 300 tx/s. Now: scheduled every LAB_RECYCLE_MINUTES (30) or when the node's tmp store exceeds LAB_RECYCLE_STORE_GB (8), never during a load test.

## Decision log
- 2026-09-14 G0: order book app; both write paths; no commits; Vite+React+viem UI, Node lab-server engine.

## Milestones
- M1 DONE 2026-09-14: orderbook program (5 unit + 1 gtest green), deployed at `0x90e8d27b826a4608607bab58ea8fcbe396dbaddd`, injected place → Promise reply id=1.

- M2 DONE 2026-09-14: lab-server engine, both paths, preconf view via calculateReplyForHandle; live vitest green.

- M3 DONE 2026-09-14: committed view from L1 logs, attribution for both paths, live tests green (5 tests).

- M4 DONE 2026-09-14: bench N=30/path: injected p50 18 ms to promise, 1.7 s to committed (5 blocks); L1 p50 0.99 s mined, 4.0 s committed (3 blocks). reports/bench-2026-09-14T06-12-22-805Z.md

- M5 DONE 2026-09-14: reorg matrix 6 cells, see invariant above.

- FINAL 2026-09-14: bench reports/bench-2026-09-14T06-26-22-235Z.md; matrix reports/reorg-matrix-2026-09-14T06-31-04-264Z.md (corrected harness, same conclusion). Retro docs/04-retro.md.

## Lessons
- `cargo build -p ethexe-cli --release` needs `protoc` and `cmake` (brew) and the pinned nightly-2025-10-20; ~25 min on M-series.
- Contracts libs are git submodules: `git submodule update --init --recursive --depth 1 -- ethexe/contracts/lib`.
