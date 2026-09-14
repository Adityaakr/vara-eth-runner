#!/usr/bin/env bash
# Upload the orderbook wasm, create its Mirror with executable balance, write run/mirror.addr.
set -euo pipefail
LAB="$(cd "$(dirname "$0")/.." && pwd)"
ETHEXE="$LAB/gear/target/release/ethexe"
export PATH="$HOME/.foundry/bin:$PATH"
WASM="$LAB/orderbook/target/wasm32-gear/release/orderbook.opt.wasm"
ROUTER="$(cat "$LAB/run/router.addr")"
SENDER="${SENDER:-0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc}"   # Anvil #2 = ethexe dev "Sender #1"
EXEC_BALANCE="${EXEC_BALANCE:-1000000000000000}"               # raw WVARA units (12 decimals => 1000 WVARA)
INSTANCES="${INSTANCES:-5}"                                    # instances: traffic uses the first 4, live tests the 5th
TX="$ETHEXE --cfg none tx --ethereum-rpc ws://127.0.0.1:8545 --ethereum-router $ROUTER --sender $SENDER"
echo "uploading $WASM as $SENDER via router $ROUTER"
UP=$($TX upload "$WASM" --watch --json)
echo "$UP"
CODE_ID=$(echo "$UP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("code_id") or d.get("codeId"))')
echo "code id $CODE_ID"
CTOR_PAYLOAD="0x474d0110000000000000000000000000"
: > "$LAB/run/mirrors.txt"
for i in $(seq 1 "$INSTANCES"); do
  CR=$($TX create "$CODE_ID" --value "$EXEC_BALANCE" --json)
  MIRROR=$(echo "$CR" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("actor_id"))')
  # The Mirror exists but the program is uninitialized until its first L1 message carries the
  # constructor payload; injected transactions to an uninitialized program are dropped
  # (`tx_validity.rs`: UninitializedDestination). `Create()` has no args: Sails header only.
  INIT=$($TX send-message "$MIRROR" "$CTOR_PAYLOAD" 0 --watch --json)
  CODE=$(echo "$INIT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["reply_info"]["code"])')
  echo "$MIRROR" >> "$LAB/run/mirrors.txt"
  [[ $i -eq 1 ]] && echo "$MIRROR" > "$LAB/run/mirror.addr"
  echo "instance $i: mirror $MIRROR init reply code $CODE"
done
# Wallet ledger program (balances, transfer, faucet), one instance.
[[ -f "$LAB/ledger/target/wasm32-gear/release/ledger.opt.wasm" ]] && "$LAB/run/deploy-ledger.sh"
