## The **orderbook** program

[![Build Status](https://github.com/gear-tech/orderbook/workflows/CI/badge.svg)](https://github.com/gear-tech/orderbook/actions/workflows/ci.yml)

Program **orderbook** for [⚙️ Gear Protocol](https://github.com/gear-tech/gear) written in [⛵ Sails](https://github.com/gear-tech/sails) framework.

The program workspace includes the following packages:
- `orderbook` is the package allowing to build WASM binary for the program and IDL file for it.
  The package also includes integration tests for the program in the `tests` sub-folder
- `orderbook-app` is the package containing business logic for the program represented by the `Orderbook` structure.
- `orderbook-client` is the package containing the client for the program allowing to interact with it from another program, tests, or off-chain client.

### 🏗️ Building

```bash
cargo build --release
```

### ✅ Testing

```bash
cargo test --release
```

> [!TIP]
> For off-chain integration tests against a running node, add the `gsdk` feature:

```bash
cargo add sails-rs --dev --features gsdk
```

# License

The source code is licensed under the [MIT license](LICENSE).
