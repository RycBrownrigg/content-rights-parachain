#!/usr/bin/env bash
#
# Deploys Snowbridge Gateway contracts on local Ethereum (Anvil/Geth).
#
# Prerequisites:
#   - Geth running on http://127.0.0.1:8545 (via start-ethereum.sh)
#   - Zombienet running with relay chain accessible
#   - forge (Foundry) installed
#   - pnpm installed
#
# Usage:
#   ./scripts/deploy-gateway.sh [relay-ws-url]
#   Default relay URL: ws://127.0.0.1:51806
#
# Outputs:
#   /tmp/snowbridge-local/contracts.json — deployed contract addresses
#   /tmp/snowbridge-local/beefy-state.json — BEEFY checkpoint

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARACHAIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SNOWBRIDGE_DIR="$(realpath "$PARACHAIN_DIR/../snowbridge")"
CONTRACT_DIR="$SNOWBRIDGE_DIR/contracts"
TEST_HELPERS_DIR="$SNOWBRIDGE_DIR/web/packages/test-helpers"
OUTPUT_DIR="/tmp/snowbridge-local"

RELAY_WS="${1:-ws://127.0.0.1:51806}"
ETH_RPC="http://127.0.0.1:8545"

echo "═══════════════════════════════════════════════════════════"
echo " Snowbridge Gateway Contract Deployment"
echo "═══════════════════════════════════════════════════════════"
echo "Relay chain: $RELAY_WS"
echo "Ethereum:    $ETH_RPC"
echo "Contracts:   $CONTRACT_DIR"

mkdir -p "$OUTPUT_DIR"

# ─── 1. Generate BEEFY checkpoint from relay chain ──────────────────────────

echo ""
echo "Step 1: Generating BEEFY checkpoint from relay chain..."
echo "  (Querying validator set at $RELAY_WS)"

# Generate checkpoint using a Node.js script since the Snowbridge
# test-helpers may have dependency issues
node -e "
const { ApiPromise, WsProvider } = require('@polkadot/api');
const fs = require('fs');

async function main() {
  const api = await ApiPromise.create({ provider: new WsProvider('$RELAY_WS') });

  // Wait for a finalized header
  const finalizedHash = await api.rpc.chain.getFinalizedHead();
  const header = await api.rpc.chain.getHeader(finalizedHash);
  const blockNumber = header.number.toNumber();
  console.log('Finalized block:', blockNumber);

  // Use a recent finalized block for the BEEFY start
  const startBlock = blockNumber;

  // Query BEEFY MMR leaf for proper keyset commitments (Merkle roots)
  const currentAuthorities = await api.query.mmrLeaf.beefyAuthorities.at(finalizedHash);
  const nextAuthorities = await api.query.mmrLeaf.beefyNextAuthorities.at(finalizedHash);

  console.log('Current set ID:', currentAuthorities.id.toNumber());
  console.log('Current set length:', currentAuthorities.len.toNumber());
  console.log('Current keyset commitment:', currentAuthorities.keysetCommitment.toHex());
  console.log('Next set ID:', nextAuthorities.id.toNumber());
  console.log('Next keyset commitment:', nextAuthorities.keysetCommitment.toHex());

  const checkpoint = {
    startBlock: startBlock,
    current: {
      id: currentAuthorities.id.toNumber(),
      root: currentAuthorities.keysetCommitment.toHex(),
      length: currentAuthorities.len.toNumber()
    },
    next: {
      id: nextAuthorities.id.toNumber(),
      root: nextAuthorities.keysetCommitment.toHex(),
      length: nextAuthorities.len.toNumber()
    }
  };

  fs.writeFileSync('$OUTPUT_DIR/beefy-state.json', JSON.stringify(checkpoint, null, 2));
  console.log('BEEFY checkpoint written to $OUTPUT_DIR/beefy-state.json');
  console.log(JSON.stringify(checkpoint, null, 2));

  await api.disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
"

echo "  BEEFY checkpoint generated."

# ─── 2. Deploy contracts via Forge ──────────────────────────────────────────

echo ""
echo "Step 2: Deploying Gateway contracts on Ethereum..."

# Copy beefy-state.json to contract dir (DeployLocal.sol reads from project root)
cp "$OUTPUT_DIR/beefy-state.json" "$CONTRACT_DIR/beefy-state.json"

# Set environment variables for DeployLocal.sol
export PRIVATE_KEY="0x4e9444a6efd6d42725a250b650a781da2737ea308c839eaccb0f7f3dbd2fea77"
export RANDAO_COMMIT_DELAY=4
export RANDAO_COMMIT_EXP=32
export MINIMUM_REQUIRED_SIGNATURES=1
export FIAT_SHAMIR_REQUIRED_SIGNATURES=1
export CREATE_ASSET_FEE=100000000000
export RESERVE_TRANSFER_FEE=100000000000
export RESERVE_TRANSFER_MAX_DESTINATION_FEE=10000000000000
export EXCHANGE_RATE=2500000000000000
export DELIVERY_COST=10000000000
export FEE_MULTIPLIER=1000000000000000000
export FOREIGN_TOKEN_DECIMALS=12
export GATEWAY_PROXY_INITIAL_DEPOSIT=10000000000000000000

cd "$CONTRACT_DIR"

# Clean previous broadcast artifacts
rm -rf broadcast

echo "  Running forge script DeployLocal.sol..."
RUST_LOG=forge forge script \
  --rpc-url "$ETH_RPC" \
  --broadcast \
  --legacy \
  -vvvv \
  scripts/DeployLocal.sol:DeployLocal 2>&1 | tee "$OUTPUT_DIR/forge-deploy.log" | tail -30

# ─── 3. Extract deployed addresses ─────────────────────────────────────────

echo ""
echo "Step 3: Extracting deployed contract addresses..."

# Parse forge broadcast output to get contract addresses
BROADCAST_FILE=$(find "$CONTRACT_DIR/broadcast" -name "run-latest.json" | head -1)

if [ -z "$BROADCAST_FILE" ]; then
  echo "ERROR: No broadcast file found. Deployment may have failed."
  echo "Check $OUTPUT_DIR/forge-deploy.log"
  exit 1
fi

# Extract contract addresses from broadcast
node -e "
const fs = require('fs');
const broadcast = JSON.parse(fs.readFileSync('$BROADCAST_FILE', 'utf8'));

const contracts = {};
for (const tx of broadcast.transactions) {
  if (tx.transactionType === 'CREATE') {
    contracts[tx.contractName] = tx.contractAddress;
  }
}

console.log('Deployed contracts:');
for (const [name, addr] of Object.entries(contracts)) {
  console.log('  ' + name + ': ' + addr);
}

fs.writeFileSync('$OUTPUT_DIR/contracts.json', JSON.stringify(contracts, null, 2));
console.log('\nWritten to $OUTPUT_DIR/contracts.json');
"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Gateway Deployment Complete"
echo "═══════════════════════════════════════════════════════════"
echo "  Contracts: $OUTPUT_DIR/contracts.json"
echo "  BEEFY state: $OUTPUT_DIR/beefy-state.json"
echo ""
echo "  Next steps:"
echo "    1. Force beacon checkpoint on Bridge Hub"
echo "    2. Build and start the relayer"
echo "═══════════════════════════════════════════════════════════"
