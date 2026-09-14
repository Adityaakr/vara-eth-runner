#!/usr/bin/env bash
# Start (or restart) the local Vara.eth dev stack: ethexe dev node + embedded Anvil 1.7.0.
# Usage: run/start-node.sh [--quarantine N] [--block-time S]
set -euo pipefail
LAB="$(cd "$(dirname "$0")/.." && pwd)"
ETHEXE="$LAB/gear/target/release/ethexe"
export PATH="$HOME/.foundry/bin:$PATH"
QUARANTINE=0
BLOCK_TIME=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quarantine) QUARANTINE="$2"; shift 2 ;;
    --block-time) BLOCK_TIME="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
anvil --version | grep -q "f83bad912a" || { echo "need Foundry 1.7.0: foundryup --install 1.7.0" >&2; exit 1; }
# Stop any previous node and its Anvil, then wait until both ports are actually free: a node that
# starts while the old Anvil still holds :8545 silently attaches to the old chain.
pkill -f "ethexe --cfg none run" 2>/dev/null || true
pkill -f "anvil -p 8545" 2>/dev/null || true
for i in $(seq 1 50); do
  lsof -nP -iTCP:8545 -sTCP:LISTEN >/dev/null 2>&1 || lsof -nP -iTCP:9944 -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 0.2
done
if lsof -nP -iTCP:8545 -sTCP:LISTEN >/dev/null 2>&1; then
  pkill -9 -f "anvil -p 8545" 2>/dev/null || true; sleep 0.5
fi
# `--tmp` databases are never pruned by the node (64 GB after 40 min at 25 tx/s); reclaim old ones.
rm -rf "${TMPDIR:-/tmp}"/ethexe* 2>/dev/null || true
rm -f "$LAB/run/counter.codeid" "$LAB/run/counters.txt"   # code ids are per chain
nohup "$ETHEXE" --cfg none run --dev --tmp \
  --rpc-port 9944 --rpc-cors all \
  --block-time "$BLOCK_TIME" \
  --canonical-quarantine "$QUARANTINE" \
  --validators-malachite-pub-keys "$LAB/run/malachite-validators.json" \
  > "$LAB/run/node.log" 2>&1 &
NODE_PID=$!
echo "node pid $NODE_PID (quarantine=$QUARANTINE block-time=${BLOCK_TIME}s) log: $LAB/run/node.log"
printf '{"quarantine": %s, "blockTime": %s, "startedAt": "%s"}\n' "$QUARANTINE" "$BLOCK_TIME" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LAB/run/node.json"
# wait until the ethexe RPC answers and Anvil has the Router
for i in $(seq 1 60); do
  if curl -sf -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"routerAddress","params":[]}' http://127.0.0.1:9944 >/dev/null 2>&1; then
    ROUTER=$(curl -s -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"routerAddress","params":[]}' http://127.0.0.1:9944 | sed -E 's/.*"result":"([^"]+)".*/\1/')
    HEAD=$(cast block-number --rpc-url http://127.0.0.1:8545 2>/dev/null || echo "?")
    ANVIL_PARENT=$(ps -o ppid= -p "$(pgrep -f 'anvil -p 8545' | head -1)" 2>/dev/null | tr -d ' ')
    if [[ "$HEAD" == "?" || "$HEAD" -gt 60 || "$ANVIL_PARENT" != "$NODE_PID" ]]; then
      echo "stack is NOT fresh: anvil head=$HEAD, anvil parent=$ANVIL_PARENT, node=$NODE_PID" >&2; exit 1
    fi
    echo "router $ROUTER (anvil head $HEAD, anvil pid parent = node $NODE_PID)"; echo "$ROUTER" > "$LAB/run/router.addr"; exit 0
  fi
  sleep 1
done
echo "node did not come up; see $LAB/run/node.log" >&2; exit 1
