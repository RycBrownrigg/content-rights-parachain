#!/usr/bin/env bash
# Fully stop any running Zombienet/parachain/relay processes, then spawn a fresh
# network so the chain uses the CURRENT binary (with pallet-contracts).
# Run from repo root. Do NOT pass --dir when spawning.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PARACHAIN_BIN="${REPO_ROOT}/target/release/parachain-template-node"
CONFIG="${REPO_ROOT}/my-content-rights.toml"

echo "=== Respawn with new runtime (so contracts appears in Chain State) ==="
echo ""
echo "1. Parachain binary that will be used:"
echo "   $PARACHAIN_BIN"
if [[ ! -x "$PARACHAIN_BIN" ]]; then
  echo "   ERROR: binary not found or not executable. Run: cargo build --release -p parachain-template-node"
  exit 1
fi
echo "   (OK)"
echo ""
echo "2. You MUST stop any running Zombienet first:"
echo "   - Go to the terminal where Zombienet is running and press Ctrl+C."
echo "   - Or run: pkill -f parachain-template-node; pkill -f zombienet"
echo "   If you don't, port 9990 may be in use and the new chain won't use your new binary."
echo ""
echo "3. Spawning fresh network (no --dir, so new chain spec from current binary)..."
echo ""

exec "$REPO_ROOT/zombienet-spawn.sh" "$CONFIG" --provider native
