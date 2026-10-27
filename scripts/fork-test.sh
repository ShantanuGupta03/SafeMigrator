#!/usr/bin/env bash
# Runs tests/integration/fork-migration.test.ts against fresh local forks of Sepolia and Chiado.
# Hardhat is installed into .fork/ (gitignored) so it never becomes an app dependency.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORK_DIR="$ROOT/.fork"
# Forking needs historical state. publicnode keeps only ~128 blocks, so forks pinned to an older
# block fail with "historical state ... is not available". These defaults serve archive state.
SEPOLIA_RPC="${FORK_SEPOLIA_RPC:-https://sepolia.drpc.org}"
CHIADO_RPC="${FORK_CHIADO_RPC:-https://rpc.chiadochain.net}"

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

# A node already listening would be an old fork whose pinned block the public RPC has pruned.
for port in 8545 8546; do
  if rpc_up "$port"; then
    echo "Port $port is already serving JSON-RPC (a leftover fork node?). Stop it first, e.g.: lsof -ti :$port | xargs kill" >&2
    exit 1
  fi
done

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

start() {
  # `exec` makes $! the hardhat process itself, so cleanup actually stops the node.
  (cd "$FORK_DIR" && FORK_CHAIN_ID="$1" FORK_URL="$2" exec ./node_modules/.bin/hardhat --config hardhat.config.cjs node --port "$3" >"$FORK_DIR/node-$1.log" 2>&1) &
  pids+=("$!")
}
start 11155111 "$SEPOLIA_RPC" 8545
start 10200 "$CHIADO_RPC" 8546

for i in 0 1; do
  port=$((8545 + i))
  for _ in $(seq 1 60); do
    rpc_up "$port" && break
    if ! kill -0 "${pids[$i]}" 2>/dev/null; then
      echo "Fork node on port $port exited; see $FORK_DIR/node-*.log" >&2
      exit 1
    fi
    sleep 1
  done
  rpc_up "$port" || { echo "Fork node on port $port did not start within 60s" >&2; exit 1; }
done

# Public RPCs prune old state quickly, so run immediately after the forks start.
cd "$ROOT"
# Extra arguments select other fork suites, e.g. tests/integration/aave-fork.test.ts.
RUN_FORK_TESTS=1 npx vitest run "${@:-tests/integration/fork-migration.test.ts}"
