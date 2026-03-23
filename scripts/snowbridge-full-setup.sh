#!/usr/bin/env bash
#
# Full Snowbridge local setup: Ethereum side + beacon checkpoint + relayers.
#
# Prerequisites:
#   - Zombienet running (4 chains: relay, Bridge Hub 1013, AssetHub 1000, Content Rights 100)
#   - HRMP channels opened + Snowbridge substrate config done
#   - Geth (brew install ethereum), Lodestar v1.35.0 at ../lodestar/
#   - Gateway contracts deployable (forge, Snowbridge contracts repo)
#   - Relayer built at ../snowbridge/relayer/build/snowbridge-relay
#
# Usage:
#   ./scripts/snowbridge-full-setup.sh <relay-ws-url>
#   Example: ./scripts/snowbridge-full-setup.sh ws://127.0.0.1:64087
#
# This script takes ~25 minutes (mostly waiting for beacon finalization).

set -eu

RELAY_WS="${1:?Usage: $0 <relay-ws-url>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARACHAIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SNOWBRIDGE_DIR="$(realpath "$PARACHAIN_DIR/../snowbridge")"
LODESTAR_DIR="$(realpath "$PARACHAIN_DIR/../lodestar")"
CONFIG_DIR="$SNOWBRIDGE_DIR/web/packages/test/config"
RELAY_BIN="$SNOWBRIDGE_DIR/relayer/build/snowbridge-relay"
OUTPUT_DIR="/tmp/snowbridge-local"

export PATH="$HOME/.local/share/pnpm:$HOME/go/bin:$PATH"

echo "═══════════════════════════════════════════════════════════"
echo " Snowbridge Full Local Setup"
echo "═══════════════════════════════════════════════════════════"
echo " Relay chain:  $RELAY_WS"
echo " Bridge Hub:   ws://127.0.0.1:8943"
echo " Output:       $OUTPUT_DIR"
echo "═══════════════════════════════════════════════════════════"

# ─── Clean up ────────────────────────────────────────────────────────────────
echo ""
echo "[1/8] Cleaning up old processes..."
pkill -f "geth.*11155111" 2>/dev/null || true
pkill -f "lodestar" 2>/dev/null || true
pkill -f "beacon-state-service" 2>/dev/null || true
pkill -f "snowbridge-relay run" 2>/dev/null || true
sleep 3

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/ethereum" "$OUTPUT_DIR/beacon-state-data" "$OUTPUT_DIR/beacon-data" "$OUTPUT_DIR/beacon-data-eth"

# ─── Start Geth ──────────────────────────────────────────────────────────────
echo ""
echo "[2/8] Starting Geth..."
geth --datadir "$OUTPUT_DIR/ethereum" --state.scheme=hash init "$CONFIG_DIR/genesis.json" 2>&1 | tail -1

geth --networkid 11155111 --datadir "$OUTPUT_DIR/ethereum" \
  --http --http.api "debug,eth,net,web3,txpool,engine,miner" \
  --http.addr 0.0.0.0 --http.vhosts "*" --http.corsdomain '*' \
  --ws --ws.api "debug,eth,net,web3" --ws.addr 0.0.0.0 --ws.origins "*" \
  --rpc.allow-unprotected-txs --authrpc.addr 0.0.0.0 --authrpc.vhosts "*" \
  --authrpc.jwtsecret "$CONFIG_DIR/jwtsecret" \
  --password /dev/null --gcmode archive --syncmode=full --state.scheme=hash \
  > "$OUTPUT_DIR/geth.log" 2>&1 &
GETH_PID=$!
echo "  Geth PID: $GETH_PID"

# Wait for Geth RPC
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:8545 -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' 2>/dev/null | grep -q result; then
    echo "  Geth RPC ready."
    break
  fi
  sleep 1
done

# ─── Start Lodestar ──────────────────────────────────────────────────────────
echo ""
echo "[3/8] Starting Lodestar v1.35.0 (mainnet preset, 512 sync committee)..."

export LODESTAR_PRESET="mainnet"
GENESIS_HASH=$(curl -s http://127.0.0.1:8545 -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"eth_getBlockByNumber","params":["0x0",false]}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['hash'])")
GENESIS_TIME=$(gdate -d'+10second' +%s)

"$LODESTAR_DIR/lodestar" dev \
  --genesisValidators 8 --genesisTime "$GENESIS_TIME" --startValidators "0..7" \
  --enr.ip6 "127.0.0.1" --rest.address "0.0.0.0" \
  --eth1.providerUrls "http://127.0.0.1:8545" --execution.urls "http://127.0.0.1:8551" \
  --dataDir "$OUTPUT_DIR/ethereum/beacon" --reset \
  --terminal-total-difficulty-override 0 --genesisEth1Hash "$GENESIS_HASH" \
  --params.ALTAIR_FORK_EPOCH 0 --params.BELLATRIX_FORK_EPOCH 0 --params.CAPELLA_FORK_EPOCH 0 \
  --params.DENEB_FORK_EPOCH 0 --params.ELECTRA_FORK_EPOCH 0 --params.FULU_FORK_EPOCH 50000000 \
  --rest.namespace="*" --jwt-secret "$CONFIG_DIR/jwtsecret" \
  --chain.archiveStateEpochFrequency 1 --serveHistoricalState true \
  > "$OUTPUT_DIR/lodestar.log" 2>&1 &
LODESTAR_PID=$!
echo "  Lodestar PID: $LODESTAR_PID"

# Wait for Lodestar API
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:9596/eth/v1/node/version 2>/dev/null | grep -q version; then
    echo "  Lodestar API ready."
    break
  fi
  sleep 1
done

# Verify mainnet preset
SYNC_SIZE=$(curl -s http://127.0.0.1:9596/eth/v1/config/spec 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['SYNC_COMMITTEE_SIZE'])" 2>/dev/null)
echo "  Sync committee size: $SYNC_SIZE"
if [ "$SYNC_SIZE" != "512" ]; then
  echo "ERROR: Expected 512 sync committee size, got $SYNC_SIZE"
  exit 1
fi

# ─── Deploy Gateway contracts ───────────────────────────────────────────────
echo ""
echo "[4/8] Deploying Gateway contracts..."
bash "$SCRIPT_DIR/deploy-gateway.sh" "$RELAY_WS" 2>&1 | grep -E "^(Step|═|Deployed|Written|BEEFY)" | head -20

# ─── Wait for beacon finalization ────────────────────────────────────────────
echo ""
echo "[5/8] Waiting for beacon finalization (~20 minutes)..."
echo "  Checking every 60 seconds..."

START_TIME=$(date +%s)
while true; do
  ELAPSED=$(( $(date +%s) - START_TIME ))
  SLOT=$(curl -s http://127.0.0.1:9596/eth/v1/beacon/headers/head 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['header']['message']['slot'])" 2>/dev/null || echo "?")
  FIN_EPOCH=$(curl -s http://127.0.0.1:9596/eth/v1/beacon/states/finalized/finality_checkpoints 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['finalized']['epoch'])" 2>/dev/null || echo "0")
  JUST_EPOCH=$(curl -s http://127.0.0.1:9596/eth/v1/beacon/states/finalized/finality_checkpoints 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['current_justified']['epoch'])" 2>/dev/null || echo "0")

  echo "  [${ELAPSED}s] slot=$SLOT fin=$FIN_EPOCH just=$JUST_EPOCH"

  if [ "$FIN_EPOCH" != "0" ] && [ "$FIN_EPOCH" != "?" ] && [ -n "$FIN_EPOCH" ]; then
    echo "  Finalized at epoch $FIN_EPOCH!"
    break
  fi

  if [ $ELAPSED -gt 2400 ]; then
    echo "  WARNING: Timeout after 40 minutes. Continuing anyway..."
    break
  fi

  sleep 60
done

# ─── Start beacon state service (immediately after finalization) ─────────────
echo ""
echo "[6/8] Starting beacon state service..."

# Write corrected config (epoch numbers, not hex)
cat > "$OUTPUT_DIR/beacon-state-service.json" << 'SVCEOF'
{
  "beacon": {
    "endpoint": "http://127.0.0.1:9596",
    "spec": {
      "syncCommitteeSize": 512,
      "slotsInEpoch": 32,
      "epochsPerSyncCommitteePeriod": 256,
      "forkVersions": { "deneb": 0, "electra": 0, "fulu": 5000000 }
    },
    "datastore": {
      "location": "/tmp/snowbridge-local/beacon-state-data",
      "maxEntries": 100
    }
  },
  "http": { "port": 8080, "readTimeout": "30s", "writeTimeout": "60s" },
  "cache": { "maxProofs": 1000, "proofTTLSeconds": 3600 },
  "persist": { "enabled": true, "saveIntervalHours": 12, "maxEntries": 10 },
  "watch": { "enabled": true, "pollIntervalSeconds": 12 }
}
SVCEOF

$RELAY_BIN run beacon-state-service --config "$OUTPUT_DIR/beacon-state-service.json" > "$OUTPUT_DIR/beacon-state-svc.log" 2>&1 &
STATE_SVC_PID=$!
echo "  State service PID: $STATE_SVC_PID"

# Wait for state service to be ready and cache proofs
for i in $(seq 1 30); do
  CACHE=$(curl -s http://127.0.0.1:8080/health 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('proofCacheSize',0))" 2>/dev/null || echo "0")
  if [ "$CACHE" -gt 0 ] 2>/dev/null; then
    echo "  State service ready (cached $CACHE proofs)."
    break
  fi
  sleep 2
done

# ─── Force beacon checkpoint on Bridge Hub ───────────────────────────────────
echo ""
echo "[7/8] Generating and forcing beacon checkpoint on Bridge Hub..."

# Write relay config
cat > "$OUTPUT_DIR/beacon-relay.json" << 'RELEOF'
{
  "source": {
    "beacon": {
      "endpoint": "http://127.0.0.1:9596",
      "stateServiceEndpoint": "http://127.0.0.1:8080",
      "spec": {
        "syncCommitteeSize": 512,
        "slotsInEpoch": 32,
        "epochsPerSyncCommitteePeriod": 256,
        "forkVersions": { "deneb": 0, "electra": 0, "fulu": 5000000 }
      },
      "datastore": {
        "location": "/tmp/snowbridge-local/beacon-data",
        "maxEntries": 100
      }
    }
  },
  "sink": {
    "parachain": {
      "endpoint": "ws://127.0.0.1:8943",
      "maxWatchedExtrinsics": 8,
      "headerRedundancy": 20,
      "heartbeat-secs": 45
    },
    "updateSlotInterval": 32
  }
}
RELEOF

# Generate checkpoint
$RELAY_BIN generate-beacon-checkpoint --config "$OUTPUT_DIR/beacon-relay.json" 2>/dev/null | grep -v "^{" > "$OUTPUT_DIR/beacon-checkpoint.hex"
CKPT_SIZE=$(wc -c < "$OUTPUT_DIR/beacon-checkpoint.hex" | tr -d ' ')
echo "  Checkpoint generated: $CKPT_SIZE bytes"

# Force checkpoint via relay sudo XCM
node -e "
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
const { readFileSync } = require('fs');
(async () => {
  const hex = readFileSync('$OUTPUT_DIR/beacon-checkpoint.hex', 'utf8').trim();
  const call = '0x5200' + hex;
  const api = await ApiPromise.create({ provider: new WsProvider('$RELAY_WS') });
  await cryptoWaitReady();
  const alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
  const dest = { V4: { parents: 0, interior: { X1: [{ Parachain: 1013 }] } } };
  const msg = { V4: [
    { UnpaidExecution: { weight_limit: 'Unlimited' } },
    { Transact: { origin_kind: 'Superuser', require_weight_at_most: { ref_time: 500000000000, proof_size: 50000000 }, call: { encoded: call } } }
  ]};
  await new Promise((resolve, reject) => {
    api.tx.sudo.sudo(api.tx.xcmPallet.send(dest, msg)).signAndSend(alice, ({ status, dispatchError }) => {
      if (dispatchError) reject(new Error(dispatchError.toString()));
      if (status.isInBlock) { console.log('  Checkpoint XCM sent'); resolve(); }
    });
  });
  await new Promise(r => setTimeout(r, 20000));
  const bhApi = await ApiPromise.create({ provider: new WsProvider('ws://127.0.0.1:8943') });
  const root = await bhApi.query.ethereumBeaconClient.latestFinalizedBlockRoot();
  const isSet = root.toHex() !== '0x' + '0'.repeat(64);
  console.log('  Beacon root:', root.toHex().substring(0, 20) + '...');
  console.log(isSet ? '  ✓ Checkpoint set!' : '  ✗ FAILED');
  await api.disconnect(); await bhApi.disconnect();
  process.exit(isSet ? 0 : 1);
})();
" 2>/dev/null

# ─── Start relayers ──────────────────────────────────────────────────────────
echo ""
echo "[8/8] Starting relayers..."

# Fund relayer accounts on Bridge Hub
node -e "
const { ApiPromise, WsProvider, Keyring } = require('@polkadot/api');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
(async () => {
  const api = await ApiPromise.create({ provider: new WsProvider('$RELAY_WS') });
  const bhApi = await ApiPromise.create({ provider: new WsProvider('ws://127.0.0.1:8943') });
  await cryptoWaitReady();
  const kr = new Keyring({ type: 'sr25519' });
  const alice = kr.addFromUri('//Alice');
  const amount = '100000000000000000';
  const batch = bhApi.tx.utility.batchAll([
    bhApi.tx.balances.forceSetBalance(kr.addFromUri('//BeaconRelay').address, amount),
    bhApi.tx.balances.forceSetBalance(kr.addFromUri('//ExecutionRelayAssetHub').address, amount),
  ]);
  const dest = { V4: { parents: 0, interior: { X1: [{ Parachain: 1013 }] } } };
  const msg = { V4: [
    { UnpaidExecution: { weight_limit: 'Unlimited' } },
    { Transact: { origin_kind: 'Superuser', require_weight_at_most: { ref_time: 5000000000, proof_size: 500000 }, call: { encoded: batch.method.toHex() } } }
  ]};
  await new Promise((resolve, reject) => {
    api.tx.sudo.sudo(api.tx.xcmPallet.send(dest, msg)).signAndSend(alice, ({ status, dispatchError }) => {
      if (dispatchError) reject(new Error(dispatchError.toString()));
      if (status.isInBlock) resolve();
    });
  });
  console.log('  Relayer accounts funded');
  await new Promise(r => setTimeout(r, 15000));
  await api.disconnect(); await bhApi.disconnect();
  process.exit(0);
})();
" 2>/dev/null

# Ethereum relay config
cat > "$OUTPUT_DIR/ethereum-relay.json" << 'ETHEOF'
{
  "source": {
    "ethereum": { "endpoint": "ws://127.0.0.1:8546" },
    "contracts": { "Gateway": "0xb1185ede04202fe62d38f5db72f71e38ff3e8305" },
    "channel-id": "0xc173fac324158e77fb5840738a1a541f633cbec8884c6a601c567d2b376a0539",
    "beacon": {
      "endpoint": "http://127.0.0.1:9596",
      "stateServiceEndpoint": "http://127.0.0.1:8080",
      "spec": {
        "syncCommitteeSize": 512,
        "slotsInEpoch": 32,
        "epochsPerSyncCommitteePeriod": 256,
        "forkVersions": { "deneb": 0, "electra": 0, "fulu": 5000000 }
      },
      "datastore": {
        "location": "/tmp/snowbridge-local/beacon-data-eth",
        "maxEntries": 100
      }
    }
  },
  "sink": {
    "parachain": {
      "endpoint": "ws://127.0.0.1:8943",
      "maxWatchedExtrinsics": 8,
      "headerRedundancy": 20,
      "heartbeat-secs": 45
    },
    "ss58Prefix": 42
  },
  "instantVerification": false,
  "ofac": { "enabled": false, "apiKey": "" }
}
ETHEOF

# Start beacon relay
$RELAY_BIN run beacon \
  --config "$OUTPUT_DIR/beacon-relay.json" \
  --substrate.private-key "//BeaconRelay" \
  > "$OUTPUT_DIR/beacon-relay.log" 2>&1 &
BEACON_RELAY_PID=$!
echo "  Beacon relay PID: $BEACON_RELAY_PID"

# Start ethereum relay
$RELAY_BIN run ethereum \
  --config "$OUTPUT_DIR/ethereum-relay.json" \
  --substrate.private-key "//ExecutionRelayAssetHub" \
  > "$OUTPUT_DIR/ethereum-relay.log" 2>&1 &
ETH_RELAY_PID=$!
echo "  Ethereum relay PID: $ETH_RELAY_PID"

sleep 15

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Snowbridge Local Setup Complete"
echo "═══════════════════════════════════════════════════════════"
echo "  Geth:             PID $GETH_PID  (http://127.0.0.1:8545)"
echo "  Lodestar:         PID $LODESTAR_PID  (http://127.0.0.1:9596)"
echo "  State service:    PID $STATE_SVC_PID  (http://127.0.0.1:8080)"
echo "  Beacon relay:     PID $BEACON_RELAY_PID"
echo "  Ethereum relay:   PID $ETH_RELAY_PID"
echo ""
echo "  Contracts:        $OUTPUT_DIR/contracts.json"
echo "  Logs:             $OUTPUT_DIR/*.log"
echo ""
echo "  Beacon relay status:"
tail -5 "$OUTPUT_DIR/beacon-relay.log" 2>/dev/null | sed 's/^/    /'
echo ""
echo "  Ethereum relay status:"
tail -5 "$OUTPUT_DIR/ethereum-relay.log" 2>/dev/null | sed 's/^/    /'
echo "═══════════════════════════════════════════════════════════"

# Save PIDs
cat > "$OUTPUT_DIR/pids.txt" << EOF
GETH_PID=$GETH_PID
LODESTAR_PID=$LODESTAR_PID
STATE_SVC_PID=$STATE_SVC_PID
BEACON_RELAY_PID=$BEACON_RELAY_PID
ETH_RELAY_PID=$ETH_RELAY_PID
EOF
