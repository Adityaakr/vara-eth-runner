#!/usr/bin/env bash
# Upload the ledger wasm, create one Mirror with executable balance, initialise it, write run/counters.txt.
set -euo pipefail
LAB="$(cd "$(dirname "$0")/.." && pwd)"
ETHEXE="$LAB/gear/target/release/ethexe"
export PATH="$HOME/.foundry/bin:$PATH"
WASM="$LAB/counter/target/wasm32-gear/release/counter.opt.wasm"
ROUTER="$(cat "$LAB/run/router.addr")"
SENDER="${SENDER:-0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc}"
EXEC_BALANCE="${EXEC_BALANCE:-1000000000000000}"
INSTANCES="${INSTANCES:-4}"
TX="$ETHEXE --cfg none tx --ethereum-rpc ws://127.0.0.1:8545 --ethereum-router $ROUTER --sender $SENDER"
# The Router rejects re-validation of known code; reuse the code id once uploaded on this stack.
if [[ -f "$LAB/run/counter.codeid" ]]; then
  CODE_ID=$(cat "$LAB/run/counter.codeid")
else
  UP=$($TX upload "$WASM" --watch --json)
  CODE_ID=$(echo "$UP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("code_id") or d.get("codeId"))')
  echo "$CODE_ID" > "$LAB/run/counter.codeid"
fi
: > "$LAB/run/counters.txt"
for i in $(seq 1 "$INSTANCES"); do
  CR=$($TX create "$CODE_ID" --value "$EXEC_BALANCE" --json)
  MIRROR=$(echo "$CR" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("actor_id"))')
  INIT=$($TX send-message "$MIRROR" "0x474d0110000000000000000000000000" 0 --watch --json)
  CODE=$(echo "$INIT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["reply_info"]["code"])')
  echo "$MIRROR" >> "$LAB/run/counters.txt"
  echo "counter $i: mirror $MIRROR init reply code $CODE"
done
