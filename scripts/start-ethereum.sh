#!/usr/bin/env bash
#
# Starts local Ethereum execution + consensus layer for Snowbridge testing.
#
# Prerequisites:
#   - geth (brew install ethereum)
#   - lodestar (pnpm add -g @chainsafe/lodestar)
#   - coreutils for gdate on macOS (brew install coreutils)
#
# Usage:
#   ./scripts/start-ethereum.sh
#
# Outputs:
#   Geth RPC: http://127.0.0.1:8545  (execution layer)
#   Geth WS:  ws://127.0.0.1:8546
#   Geth Auth: http://127.0.0.1:8551  (engine API for beacon)
#   Lodestar:  http://127.0.0.1:9596  (beacon REST API)
#
# Logs: /tmp/snowbridge-local/geth.log, /tmp/snowbridge-local/lodestar.log
# Data: /tmp/snowbridge-local/ethereum/
#
# Stop: kill %1 %2  (or kill the PIDs printed)

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SNOWBRIDGE_DIR="$(realpath "$SCRIPT_DIR/../../snowbridge")"
CONFIG_DIR="$SNOWBRIDGE_DIR/web/packages/test/config"
OUTPUT_DIR="/tmp/snowbridge-local"
ETH_DATA_DIR="$OUTPUT_DIR/ethereum"
JWT_SECRET="$CONFIG_DIR/jwtsecret"

# Deployer key (from Snowbridge test config — pre-funded in genesis)
export DEPLOYER_ETH_KEY="0x4e9444a6efd6d42725a250b650a781da2737ea308c839eaccb0f7f3dbd2fea77"

echo "═══════════════════════════════════════════════════════════"
echo " Snowbridge Local Ethereum Setup"
echo "═══════════════════════════════════════════════════════════"
echo "Output dir: $OUTPUT_DIR"
echo "Config dir: $CONFIG_DIR"

# Clean previous state
rm -rf "$ETH_DATA_DIR"
mkdir -p "$OUTPUT_DIR" "$ETH_DATA_DIR"

# ─── 1. Verify prerequisites ────────────────────────────────────────────────

echo ""
echo "Checking prerequisites..."

# Add pnpm global bin to PATH (Lodestar installed via pnpm)
export PATH="$HOME/.local/share/pnpm:$PATH"

for cmd in geth lodestar forge; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found. Please install it first."
    exit 1
  fi
done

# Need gdate on macOS for timestamp generation
if [[ "$(uname)" == "Darwin" ]]; then
  if ! command -v gdate &>/dev/null; then
    echo "ERROR: gdate not found. Install coreutils: brew install coreutils"
    exit 1
  fi
fi

echo "All prerequisites found."

# ─── 2. Initialize and start Geth ───────────────────────────────────────────

echo ""
echo "Initializing Geth with Snowbridge genesis..."
geth --datadir "$ETH_DATA_DIR" --state.scheme=hash init "$CONFIG_DIR/genesis.json" 2>&1 | tail -3

echo "Starting Geth (chain ID: 11155111)..."
geth \
  --networkid 11155111 \
  --datadir "$ETH_DATA_DIR" \
  --http --http.api "debug,eth,net,web3,txpool,engine,miner" \
  --http.addr 0.0.0.0 --http.vhosts "*" --http.corsdomain '*' \
  --ws --ws.api "debug,eth,net,web3" \
  --ws.addr 0.0.0.0 --ws.origins "*" \
  --rpc.allow-unprotected-txs \
  --authrpc.addr 0.0.0.0 --authrpc.vhosts "*" \
  --authrpc.jwtsecret "$JWT_SECRET" \
  --password /dev/null \
  --gcmode archive --syncmode=full --state.scheme=hash \
  > "$OUTPUT_DIR/geth.log" 2>&1 &

GETH_PID=$!
echo "Geth started (PID: $GETH_PID)"
echo "  RPC: http://127.0.0.1:8545"
echo "  WS:  ws://127.0.0.1:8546"
echo "  Log: $OUTPUT_DIR/geth.log"

# Wait for Geth to be ready
echo "Waiting for Geth RPC..."
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:8545 -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | grep -q result; then
    echo "Geth RPC is ready."
    break
  fi
  sleep 1
done

# ─── 3. Start Lodestar beacon node ──────────────────────────────────────────

echo ""
echo "Starting Lodestar beacon node (dev mode)..."

# Get genesis hash from Geth
GENESIS_HASH=$(curl -s http://127.0.0.1:8545 \
  -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"eth_getBlockByNumber","params":["0x0",false]}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['hash'])")
echo "Geth genesis hash: $GENESIS_HASH"

# Compute genesis time (10 seconds from now)
if [[ "$(uname)" == "Darwin" ]]; then
  GENESIS_TIME=$(gdate -d'+10second' +%s)
else
  GENESIS_TIME=$(date -d'+10second' +%s)
fi

export LODESTAR_PRESET="mainnet"

lodestar dev \
  --genesisValidators 8 \
  --genesisTime "$GENESIS_TIME" \
  --startValidators "0..7" \
  --enr.ip6 "127.0.0.1" \
  --rest.address "0.0.0.0" \
  --eth1.providerUrls "http://127.0.0.1:8545" \
  --execution.urls "http://127.0.0.1:8551" \
  --dataDir "$ETH_DATA_DIR/beacon" \
  --reset \
  --genesisEth1Hash "$GENESIS_HASH" \
  --params.ALTAIR_FORK_EPOCH 0 \
  --params.BELLATRIX_FORK_EPOCH 0 \
  --params.CAPELLA_FORK_EPOCH 0 \
  --params.DENEB_FORK_EPOCH 0 \
  --params.ELECTRA_FORK_EPOCH 0 \
  --params.FULU_FORK_EPOCH 50000000 \
  --rest.namespace="*" \
  --jwt-secret "$JWT_SECRET" \
  --chain.archiveStateEpochFrequency 1 \
  --serveHistoricalState true \
  > "$OUTPUT_DIR/lodestar.log" 2>&1 &

LODESTAR_PID=$!
echo "Lodestar started (PID: $LODESTAR_PID)"
echo "  REST API: http://127.0.0.1:9596"
echo "  Log: $OUTPUT_DIR/lodestar.log"

# Wait for Lodestar to be ready
echo "Waiting for Lodestar beacon API..."
for i in $(seq 1 60); do
  if curl -s http://127.0.0.1:9596/eth/v1/node/version 2>/dev/null | grep -q version; then
    echo "Lodestar beacon API is ready."
    break
  fi
  if [ $i -eq 60 ]; then
    echo "WARNING: Lodestar didn't become ready in 60s. Check $OUTPUT_DIR/lodestar.log"
  fi
  sleep 1
done

# ─── 4. Print summary ───────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Ethereum Local Network Running"
echo "═══════════════════════════════════════════════════════════"
echo "  Geth PID:     $GETH_PID"
echo "  Lodestar PID: $LODESTAR_PID"
echo "  Geth RPC:     http://127.0.0.1:8545"
echo "  Geth WS:      ws://127.0.0.1:8546"
echo "  Beacon API:   http://127.0.0.1:9596"
echo ""
echo "  PIDs file:    $OUTPUT_DIR/pids.txt"
echo ""
echo "  To stop: kill $GETH_PID $LODESTAR_PID"
echo "═══════════════════════════════════════════════════════════"

# Save PIDs for cleanup
echo "GETH_PID=$GETH_PID" > "$OUTPUT_DIR/pids.txt"
echo "LODESTAR_PID=$LODESTAR_PID" >> "$OUTPUT_DIR/pids.txt"

# Keep running in foreground
wait
