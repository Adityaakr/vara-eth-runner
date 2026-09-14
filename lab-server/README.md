# lab-server

The measurement engine. Node 22, TypeScript, ESM.

| Module | Role |
|---|---|
| `chain.ts` | connections: viem to Anvil, `@vara-eth/api` to the validator RPC, Anvil mnemonic accounts |
| `sails.ts` | Sails IDL v2 codec (16-byte header + SCALE) via sails-js; encode `place/cancel/book/seq`, decode replies |
| `engine.ts` | `placeInjected`, `placeL1`, `prepareInjected`/`sendPrepared` (external signer), `preconfBook`, attribution of committed logs |
| `l1watch.ts` | reorg-safe watcher: polls Anvil, checks the last head hash before and after `getLogs`, rebuilds from genesis on mismatch |
| `committed.ts` | pure event replay into a `BookView`; strict `seq` continuity |
| `timeline.ts` | `WriteRecord` and nearest-rank percentiles |
| `blast.ts`, `blast-cli.ts` | load generator (concurrent, crossing orders, per-instance side alternation) |
| `traffic-cli.ts` | autopilot: token-bucket steady rate plus periodic surges |
| `bench.ts`, `reorg.ts`, `stack.ts` | benchmark, reorg matrix, node/Anvil control |
| `serve.ts` | WebSocket telemetry server: snapshots, blast/autopilot/reorg commands, passkey `prepare` + `submitSigned` |

```bash
npm test                     # vitest: 5 offline + 6 live (stack must be up and deployed)
npm run serve                # ws://127.0.0.1:8787 · LAB_AUTOPILOT_RATE (default 25) · LAB_WS_PORT
npm run blast -- 1000 64 8   # LAB_MIRRORS=a,b,c LAB_FIRST_SENDER=5
npm run bench -- 30
npm run reorg-matrix -- --quarantine 0,4 --depth 1,3,6 --observe 40
```

Timing rule: `tSubmit` is taken after signing, right before the send; `tPreconf` when the validator-signed receipt
arrives; `tCommitted` when the watcher first sees the log (mine time + ≤ 50 ms poll). Records from child processes are
kept in a 4000-entry ring; all-time totals are counters.
