#!/usr/bin/env bash
# Upload the ledger wasm, create one Mirror with executable balance, initialise it, write run/ledger.addr.
set -euo pipefail
LAB="$(cd "$(dirname "$0")/.." && pwd)"
ETHEXE="$LAB/gear/target/release/ethexe"
export PATH="$HOME/.foundry/bin:$PATH"
WASM="$LAB/ledger/target/wasm32-gear/release/ledger.opt.wasm"
ROUTER="$(cat "$LAB/run/router.addr")"
SENDER="${SENDER:-0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc}"
EXEC_BALANCE="${EXEC_BALANCE:-25000000000000000}"
TX="$ETHEXE --cfg none tx --ethereum-rpc ws://127.0.0.1:8545 --ethereum-router $ROUTER --sender $SENDER"
UP=$($TX upload "$WASM" --watch --json)
CODE_ID=$(echo "$UP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("code_id") or d.get("codeId"))')
CR=$($TX create "$CODE_ID" --value "$EXEC_BALANCE" --json)
MIRROR=$(echo "$CR" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("actor_id"))')
INIT=$($TX send-message "$MIRROR" "0x474d0110000000000000000000000000" 0 --watch --json)
CODE=$(echo "$INIT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["reply_info"]["code"])')
echo "$MIRROR" > "$LAB/run/ledger.addr"
echo "ledger: mirror $MIRROR init reply code $CODE"
