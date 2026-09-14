# Preconf Lab — Architecture (v1)

Date: 2026-09-14. Status: proposed (gate G1). Author: Prism ship run.

## Recommendation

Build a **three-process lab** on the local Vara.eth stack:

1. **`ethexe run --dev`** (gear v2.0.0, built from source at `gear/target/release/ethexe`). It spawns
   Anvil 1.7.0 on :8545, deploys Router `0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9`, funds 12
   accounts, and runs a single Malachite validator that finalizes one MB per Ethereum block (1s).
   It needs `--validators-malachite-pub-keys` (dev mode does not generate it) and accepts
   `--canonical-quarantine N` (dev default 0).
2. **`lab-server`** (Node 22, TypeScript, ESM). The experiment engine. Owns the Anvil dev keys,
   sends writes over both paths, subscribes to receipts and L1 logs, timestamps every hop with
   `performance.now()` in one process, maintains both views of the book, triggers reorgs, and
   streams a JSON snapshot to the UI over WebSocket. Also runnable headless for a benchmark.
3. **`lab-ui`** (Vite + React + TS). A thin viewer: two panes (pre-confirmed vs committed), a
   per-write timeline, latency stats, and controls (place order via injected or L1, reorg depth,
   quarantine label).

Program: **`orderbook`** — a Sails 2.0.0 ethexe program (scaffold `cargo sails new --eth`), one
service `Book` with commands `place(side, price, qty) -> u64`, `cancel(id) -> bool`, queries
`book() -> BookView`, `seq() -> u64`, and eth events `Placed`, `Filled`, `Cancelled` with
`#[indexed]` ids. Price-time priority, integer prices, no value transfer, one instrument.

## Why this shape

- **Two views come from two genuinely different sources.** Pre-confirmed = `program_calculateReplyForHandle`
  against the validator's latest computed MB (`ethexe/rpc/src/apis/program.rs:131-165`; note the `at`
  argument is ignored, it always answers at head). Committed = a replay of the program's eth-event logs
  emitted by the Mirror contract on Anvil when the Router commits a batch (`Mirror.sol:633-752`,
  `log1..log4` from `_sendMessages`). Nothing in the committed pane can come from the validator.
- **The receipt is the pre-confirmation.** `injected_sendTransactionAndWatch` yields a validator-signed
  `Receipt<Promise>` carrying the reply payload (`ethexe/common/src/injected.rs:146-160,232-267`).
  Its arrival time is t_preconf. `@vara-eth/api` (vendored 0.6.0-rc.0 from vara-wallet) wraps this as
  `InjectedTx.sendAndWaitForReceipt()` and validates the signature against the Router validator set.
- **Reorg behaviour is already observed, not guessed.** With quarantine 0, `anvil_reorg` depth 2
  produced: `coordinator: latest finalized MB advanced to a non-canonical Eth block — refusing to build
  batch (commitments to Eth are now blocked until recovery)` (`ethexe/consensus/src/validator/batch/manager.rs:206`).
  Injected txs referencing orphaned blocks are purged with `Outdated` / `UnknownReferenceBlock`
  (`tx_validity.rs:136-200`, `VALIDITY_WINDOW = 32`). The lab therefore measures the quarantine as the
  reorg safety margin: depth < quarantine is absorbed, depth >= quarantine halts commitments.
- **Server-side timing beats browser timing.** One process, one clock, no polyfill risk from
  `@polkadot/*` in the browser, and the same engine runs a headless benchmark that prints stats.
- **sails-js 1.0.0 (IDL v2)** provides `QueryBuilderWithHeader.payload` and `decodeResult`, i.e. the
  16-byte Sails header + SCALE encoding, without needing a GearApi connection for encoding.

## Steelman of the rejected stack

*Browser-only React app talking directly to both RPCs.* Fewer moving parts and "real dapp" shaped.
Rejected because timestamps would straddle two WebSocket clients in a browser event loop, the
`@gear-js/api` + `@polkadot/api` peer deps of sails-js are heavy in Vite, and a headless benchmark
would have to be re-implemented. The UI stays thin either way; the engine is where correctness lives.

*Pixel board instead of order book.* More visual, but the user chose the order book; matching adds a
deterministic state machine where divergence between panes is semantically meaningful (a fill that
exists in the pre-confirmed book and not yet on Ethereum).

## Assumptions and falsifiers

| Assumption | Falsifier / check |
|---|---|
| `cargo sails new --eth` builds against sails-rs 2.0.0 with `wasm32v1-none` and emits `.idl` + embeds it | Milestone 1 build; `target/wasm32v1-none/release/orderbook.idl` exists |
| Eth events from `emit_eth_event` land as Mirror logs decodable with the ABI from `cargo sails sol` | Milestone 3: viem `decodeEventLog` succeeds on Anvil logs after commit |
| `ethexe tx upload` + `tx create --value` funds executable balance enough for injected msgs | `MIN_EXECUTABLE_BALANCE_FOR_INJECTED_MESSAGES` check passes; receipt is Promise not Purged |
| `@vara-eth/api` 0.6.0-rc.0 talks to the v2.0.0 node's legacy `{recipient, tx}` injected format | Milestone 2: first injected receipt arrives |
| Committed pane lag ≈ 1 Ethereum block + batch commit; pre-confirm ≈ tens of ms | Milestone 4 stats |
| Quarantine N absorbs reorg depth < N | Milestone 5 matrix (N ∈ {0, 4}, depth ∈ {1, 3, 6}) |

## Open questions (do not block v1)

- Does the validator purge already-pre-confirmed injected txs after a reorg, or re-execute them on the
  new branch? The lab records both the receipt and whether its effects appear in committed logs.
- Recovery path after "commitments blocked": v1 restarts the node with `--tmp`; recovery is out of scope.

## Ports and addresses

- Anvil http/ws :8545, chain id 31337. ethexe RPC ws/http :9944 (CORS all). Malachite :20334.
- Deployer = Anvil #0, Validator = Anvil #1, Senders = Anvil #2..#11 (10,000 ETH + 500k WVARA each).
- Keys live in the node keystore under `~/Library/Application Support/com.Gear.ethexe/keys`; the lab
  server uses the standard Anvil mnemonic accounts directly.
