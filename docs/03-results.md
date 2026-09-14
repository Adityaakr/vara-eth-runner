# Results — 2026-09-14, fresh local stack (M-series laptop, one validator)

## Pre-confirmation latency and throughput (injected transactions)

| Load | Throughput | Median | p95 | Fastest |
|---|---|---|---|---|
| autopilot 20–25 tx/s | 20–25 tx/s | 5–25 ms | 23–46 ms | 1.9 ms |
| 200 tx, 16 in flight | 319 tx/s | 39 ms | 56 ms | 3 ms |
| 500 tx, 32 in flight | 314–334 tx/s | 76–80 ms | 104–113 ms | 9 ms |
| 1000 tx, 64 in flight (1 program) | 467 tx/s | 91 ms | 159 ms | 2 ms |
| 1000 tx, 64 in flight (4 programs) | 388 tx/s | 117 ms | 180 ms | 28 ms |
| 2000 tx, 128 in flight (4 programs) | 494 tx/s | 160 ms | 267 ms | 31 ms |
| 2 × 1000 tx, 64 in flight, two processes | 498 tx/s aggregate | 215–220 ms | 321–327 ms | 58 ms |

The ceiling is ~500 pre-confirmations/s whether load hits one or four program instances, from one or two processes. The
validator's micro-block pipeline is the limit, not WASM execution. Under saturation the median grows with the number
in flight (Little's law), which is queueing inside the validator.

## Both write paths (benchmark, 30 per path)

| Hop | Injected | Ethereum transaction |
|---|---|---|
| submit → pre-confirmed | p50 17 ms, p95 20 ms | n/a |
| submit → mined | n/a | p50 984 ms |
| submit → committed on Ethereum | p50 1.68 s, p95 2.01 s | p50 4.00 s |
| blocks from anchor to commit | 2–5 | 3 |

## Reorg matrix (corrected harness)

| quarantine | depth | in-flight re-committed | post-reorg write | seeded still committed | validator refused commitments |
|---|---|---|---|---|---|
| 0 | 1 | +0.9 s | promise 5 ms, committed +7.9 s | 3/3 | no |
| 0 | 3 | never | promise 10 ms, never committed | 0/3 | yes |
| 0 | 6 | never | promise 6 ms, never committed | 0/3 | yes |
| 4 | 1 | +0.9 s | promise 8 ms, committed +7.9 s | 3/3 | no |
| 4 | 3 | +0.9 s | promise 7 ms, committed +7.9 s | 3/3 | no |
| 4 | 6 | never | promise 5 ms, never committed | 0/3 | yes |

Rule: a reorg is absorbed iff depth ≤ canonical-quarantine + post-quarantine-delay (1). Beyond that the validator keeps
issuing signed promises in milliseconds while nothing settles again until the node is restarted.

## Sustained load

At 60 tx/s across four instances for 3.5 minutes: 13,600 transactions, zero failures, median rising from 24 ms to
51 ms as the unsettled backlog grew (each order emits two events; settlement absorbs ~120 events per block).
At 20 tx/s for 4 minutes: median 12 → 23 ms.
