#!/usr/bin/env bash
# Starts three empty local Hardhat chains with the Sepolia, Gnosis Chiado and Base Sepolia chain IDs,
# installs the canonical Safe v1.3.0 contracts on each (scripts/local-chain/seed-safe.mjs), runs the
# given command with LOCAL_RPC_<chainId> set, then stops the nodes.
#
# This needs no public RPC access. It is real EVM execution with the real Safe bytecode, but NOT
# live-network state: other protocols (Aave, tokens, indexers) do not exist on these chains.
#   bash scripts/local-chain.sh npx vitest run tests/integration/fork-migration.test.ts
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORK_DIR="$ROOT/.fork"
mkdir -p "$FORK_DIR"
cp "$ROOT/scripts/fork/hardhat.config.cjs" "$FORK_DIR/hardhat.config.cjs"
if [ ! -x "$FORK_DIR/node_modules/.bin/hardhat" ]; then
  (cd "$FORK_DIR" && [ -f package.json ] || echo '{"private":true}' > package.json)
  (cd "$FORK_DIR" && npm install --no-audit --no-fund --silent hardhat@2)
fi

rpc_up() {
  curl -sf -X POST "http://127.0.0.1:$1" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' >/dev/null 2>&1
}

CHAINS=(11155111 10200 84532)
PORTS=(8545 8546 8547)
for port in "${PORTS[@]}"; do
  if rpc_up "$port"; then
    echo "Port $port is already serving JSON-RPC. Stop it first, e.g.: lsof -ti :$port | xargs kill" >&2
    exit 1
  fi
done

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

for i in 0 1 2; do
  (cd "$FORK_DIR" && FORK_CHAIN_ID="${CHAINS[$i]}" FORK_URL="" exec ./node_modules/.bin/hardhat --config hardhat.config.cjs node --port "${PORTS[$i]}" >"$FORK_DIR/local-${CHAINS[$i]}.log" 2>&1) &
  pids+=("$!")
done
urls=()
for i in 0 1 2; do
  for _ in $(seq 1 60); do
    rpc_up "${PORTS[$i]}" && break
    sleep 1
  done
  rpc_up "${PORTS[$i]}" || { echo "Local node on port ${PORTS[$i]} did not start; see $FORK_DIR/local-*.log" >&2; exit 1; }
  urls+=("http://127.0.0.1:${PORTS[$i]}")
  export "LOCAL_RPC_${CHAINS[$i]}=http://127.0.0.1:${PORTS[$i]}"
done
node "$ROOT/scripts/local-chain/seed-safe.mjs" "${urls[@]}"

export FORK_SEPOLIA_URL="$LOCAL_RPC_11155111" FORK_CHIADO_URL="$LOCAL_RPC_10200" FORK_BASE_SEPOLIA_URL="$LOCAL_RPC_84532"
export RPC_URL_11155111="$LOCAL_RPC_11155111" RPC_URL_10200="$LOCAL_RPC_10200" RPC_URL_84532="$LOCAL_RPC_84532"
export LOCAL_CHAIN=1
cd "$ROOT"
"$@"
