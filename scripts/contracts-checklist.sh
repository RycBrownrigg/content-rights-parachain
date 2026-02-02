#!/usr/bin/env bash
# Run this from repo root when Developer → Chain state still doesn't show "contracts".
# It verifies your binary and reminds you of the exact steps for a clean spawn.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Contracts checklist (run from repo root) ==="
echo ""

echo "1. Verifying that your built binary includes pallet-contracts..."
if ! "$SCRIPT_DIR/verify-runtime-has-contracts.sh"; then
  echo ""
  echo "Your binary does NOT include contracts. Do a clean rebuild:"
  echo "  ./scripts/clean-runtime-wasm.sh"
  echo "  cargo build --release -p parachain-template-node"
  echo "  ./scripts/verify-runtime-has-contracts.sh   # must say FOUND"
  echo ""
  echo "Then kill any running Zombienet and respawn:"
  echo "  pkill -f parachain-template-node; pkill -f zombienet"
  echo "  ./zombienet-spawn.sh my-content-rights.toml --provider native"
  echo "  Connect to ws://127.0.0.1:9990 → Developer → Chain state → look for 'contracts'"
  exit 1
fi

echo ""
echo "2. Your binary is correct. If the live chain still has no 'contracts' in Chain state:"
echo "   - Stop everything: pkill -f parachain-template-node; pkill -f zombienet"
echo "   - Spawn from repo root (so the script uses the right binary path):"
echo "     cd $REPO_ROOT"
echo "     ./zombienet-spawn.sh my-content-rights.toml --provider native"
echo "   - Do NOT pass --dir; let Zombienet create a new temp dir so chain spec is built from this binary."
echo "   - After 'Network launched', connect to ws://127.0.0.1:9990 in Polkadot.js Apps."
echo "   - Developer → Chain state → the dropdown should list 'contracts'."
echo ""
echo "3. You are in the right place: Developer → Chain state. The pallet list is in the left dropdown."
exit 0
