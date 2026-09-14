<p align="left"><img src="docs/vara-eth-logo.svg" width="64" alt="Vara.eth" /></p>

# vara-eth-runner

A local Vara.eth lab that measures what a validator pre-confirmation is worth: how fast it arrives, how much throughput one validator sustains, how long until Ethereum settles it, and what happens to it when Ethereum reorganises.

Everything runs on one machine: a gear v2.0.0 ethexe node with an embedded Anvil, a Sails 2.0 order-book program, a Node measurement engine, and a live telemetry page with passkey signing.

## Architecture

```mermaid
flowchart LR
  subgraph Browser["Browser · lab-ui"]
    UI["Telemetry page"]
    PK["Passkey signer<br/>WebAuthn PRF → secp256k1"]
  end
  subgraph Server["lab-server"]
    ENG["Timing engine<br/>one monotonic clock"]
    WATCH["L1 watcher<br/>reorg-safe committed view"]
    AUTO["Autopilot · load generator"]
  end
  subgraph Vara["Vara.eth validator · ethexe"]
    EXEC["Malachite BFT · WASM execution"]
    PRG["orderbook program"]
  end
  subgraph Eth["Ethereum · Anvil"]
    ROUTER["Router"]
    MIRROR["Mirror · event logs"]
  end
  UI <-->|"WebSocket"| ENG
  PK -->|"signature"| ENG
  AUTO --> ENG
  ENG -->|"injected tx · no gas"| EXEC
  EXEC -->|"signed promise ≈ ms"| ENG
  EXEC --> PRG
  EXEC -->|"commit batch"| ROUTER --> MIRROR
  MIRROR -->|"getLogs"| WATCH --> ENG
```

```mermaid
sequenceDiagram
  participant C as Client
  participant S as lab-server
  participant V as Validator
  participant E as Ethereum
  C->>S: order
  S->>V: injected transaction (tSubmit)
  V-->>S: signed promise (tPreconf, ms)
  S-->>C: pre-confirmed
  V->>E: commit batch
  S->>E: getLogs (tCommitted, blocks)
  S-->>C: settled
```

Editable diagram: [`docs/architecture.excalidraw`](docs/architecture.excalidraw). Results: [`docs/03-results.md`](docs/03-results.md).

## Layout

```
orderbook/   Sails 2.0 ethexe program (Rust → WASM)
lab-server/  timing engine, committed-view watcher, autopilot, benchmark, reorg matrix, WS server
lab-ui/      telemetry page with passkey wallet
run/         start-node.sh · deploy.sh          docs/ · reports/ · vendor/
```

## Run

Prerequisites: Rust, `protoc`, `cmake`, Node 22, `cargo install sails-cli --version 2.0.0`, and **Foundry 1.7.0 exactly** (`foundryup --install 1.7.0`).

```bash
git clone --depth 1 --branch v2.0.0 https://github.com/gear-tech/gear.git gear && (cd gear && cargo build -p ethexe-cli --release)
(cd orderbook && cargo build --release)
run/start-node.sh --quarantine 0 && run/deploy.sh
(cd lab-server && npm install && npm run serve)     # ws://127.0.0.1:8787
(cd lab-ui && npm install && npm run dev)           # http://localhost:5173
```

Experiments, from `lab-server`: `npm test`, `npm run blast -- 1000 64 8`, `npm run bench -- 30`, `npm run reorg-matrix`.

## Notes

- Latency is one clock in one process: `tSubmit` after signing, `tPreconf` on the validator-signed receipt, `tCommitted` when the log is seen on Ethereum.
- Passkeys: the PRF secret seeds a secp256k1 key in the browser via HKDF; the key never leaves it.
- Single local validator; the order book is a lab toy. Pitfalls and verified node behaviour: [`.prism/project-model.md`](.prism/project-model.md).

MIT for lab code; `gear` and the vendored `@vara-eth/api` are GPL-3.0.
