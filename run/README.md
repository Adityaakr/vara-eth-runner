# run/

| File | Purpose |
|---|---|
| `start-node.sh [--quarantine N] [--block-time S]` | kills any previous node/Anvil, waits for :8545 and :9944 to free, starts `ethexe run --dev --tmp`, then verifies the chain is fresh (Anvil head < 60, Anvil's parent is this node). Writes `router.addr`, `node.json`. |
| `deploy.sh` (`INSTANCES`, `EXEC_BALANCE`, `SENDER`) | uploads the wasm, creates N Mirrors with executable balance, sends each its constructor over L1 (required before injected txs work). Writes `mirror.addr`, `mirrors.txt`. |
| `malachite-validators.json` | validator address → compressed secp256k1 key; dev mode does not generate it. |

Runtime files (`*.log`, `*.addr`, `mirrors.txt`, `node.json`) are git-ignored.
