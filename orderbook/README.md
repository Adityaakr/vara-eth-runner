# orderbook — Sails 2.0 ethexe program

A price-time-priority order book whose every state change emits exactly one Ethereum-style event stamped with a
monotonically increasing `seq`. Replaying the events yields the same book as the `book()` query, which is what lets the
lab compare the validator's pre-confirmed view with the Ethereum-committed view.

## Interface (service `Book`)

| Export | Transport | Notes |
|---|---|---|
| `place(side: u32, price: u64, qty: u64) -> u64` | scale + ethabi | 0 = bid, 1 = ask; matches then rests the remainder; returns the order id |
| `cancel(id: u64) -> bool` | scale + ethabi | owner-only |
| `book() -> BookView` | scale only | custom DTOs are not ABI-encoded |
| `seq() -> u64` | scale + ethabi | event sequence reached |

Events: `Placed{#id, seq, owner, side, price, qty(remaining)}`, `Filled{#taker, #maker, seq, price, qty}`, `Cancelled{#id, seq}`.
`#` marks indexed topics. Generated Solidity interface: `cargo sails sol target/wasm32-gear/release/orderbook.idl`.

## Build and test

```bash
cargo test -p orderbook-app    # 6 unit tests, no wasm build
cargo test                     # + gtest deploy/round-trip (builds wasm)
cargo build --release          # target/wasm32-gear/release/orderbook.opt.wasm + orderbook.idl (embedded too)
```

## Limits by design

256 resting orders per side, 64 recent fills kept. The capacity check runs before any mutation, so a rejected order never
half-executes. `place` is free and permissionless and `cancel` owner-only, so one account can squat every slot; this is a
lab program, not a venue.

## Things that bit us

- `u8` and `bool` cannot appear in eth events or ethabi parameters (`SolValue` impls missing); use `u32` / `u64`.
- The gtest client's `listen()` cannot decode eth-format events; assert them in unit tests via `emitter().take_events()`.
- On Vara.eth the Mirror is uninitialised until its first L1 message carries the constructor (`0x474d0110` + 12 zero bytes).
