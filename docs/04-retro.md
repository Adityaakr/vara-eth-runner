# Retro — Prism ship run, 2026-09-14

## Predicted vs shipped

| Prediction (architecture / roadmap) | What happened |
|---|---|
| `cargo sails new --eth` builds on sails-rs 2.0.0 and emits + embeds the IDL | True. `u8`/`bool` unusable in eth events and ethabi params; `u32` used. |
| Eth events land as Mirror logs decodable with the sails-sol-gen ABI | True; topic0 of `Placed(uint64,uint64,address,uint32,uint64,uint64)` matched live logs. |
| `tx upload` + `tx create --value` is enough to accept injected messages | False. The Mirror exists but the program is uninitialized until the first L1 message carries the constructor; injected txs are purged as `UninitializedDestination`, surfacing 32 blocks later as `Outdated`. |
| `@vara-eth/api` 0.6.0-rc.0 talks to the v2.0.0 node | Half. Envelope right, digest wrong ("Address mismatch"); one instance override fixes it. |
| Committed lag ≈ 1 block + batch commit; preconf ≈ tens of ms | Preconf p50 17 ms; injected→committed p50 1.7 s (2–3 blocks after anchoring at head); L1 mined p50 0.98 s, committed p50 4.0 s. |
| Quarantine N absorbs reorg depth < N | Refined: absorbed iff depth ≤ quarantine + post-quarantine-delay (1). q0 absorbs d1 only; q4 absorbs d1, d3, not d6. |

## Final reorg matrix (corrected harness, reports/reorg-matrix-2026-09-14T06-31-04-264Z.md)

| quarantine | depth | in-flight re-committed | post-reorg write | seeded still committed | node refused commitments |
|---|---|---|---|---|---|
| 0 | 1 | +0.9 s | promise 5 ms, committed +7.9 s | 3/3 | no |
| 0 | 3 | never | promise 10 ms, never committed | 0/3 | yes |
| 0 | 6 | never | promise 6 ms, never committed | 0/3 | yes |
| 4 | 1 | +0.9 s | promise 8 ms, committed +7.9 s | 3/3 | no |
| 4 | 3 | +0.9 s | promise 7 ms, committed +7.9 s | 3/3 | no |
| 4 | 6 | never | promise 5 ms, never committed | 0/3 | yes |

In every cell the seeded orders' commit block sat inside the reorg window and the committed view fell to seq 0 before
recovering (or not). One trial per cell. In cell q0/d3 the watcher rebuilt via its RPC-error path (Anvil briefly had no
block at the old head) so no reorg event fired; the outcome columns are unaffected.

## Measured lessons
- The single most important edge case is real and cheap to hit: after a reorg deeper than the anchor, the validator keeps issuing signed promises in milliseconds while it can no longer commit anything. Pre-confirmations carry no settlement guarantee on their own.
- The lab's first reorg matrix was wrong in a way the reviewers caught: committed timestamps survived watcher rebuilds, so re-commit times were the pre-reorg times. Invalidating derived state on rebuild is a rule, not a detail.
- Measurement asymmetries hide in library defaults: viem's 4 s receipt polling, the API's head−3 reference block, and tx preparation inside the L1 window each moved a headline number.

## Loop telemetry
- Milestones: 6 planned, 6 shipped; 2 self-inserted fixes (init message; injected digest override).
- Build-loop iterations that needed a second run: M1 (3: SolValue types, test harness, hung gtest listener), M2 (2), M3 (2), M6 (4, JSX runtime under tsx).
- Agents: 3 reviewers in feedback (Opus ×2, Sonnet ×1), 0 in design. Feedback produced 2 critical, 7 high findings; all critical/high fixed and re-verified.
