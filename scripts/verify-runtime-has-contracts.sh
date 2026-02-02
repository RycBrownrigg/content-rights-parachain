#!/usr/bin/env bash
# Verify that the built parachain-template-node binary includes the Contracts pallet
# in its runtime. Run from repo root after: cargo build --release -p parachain-template-node
#
# If this script prints "Contracts pallet: FOUND", the binary is correct and the
# chain you're connecting to was created with a different (older) binary.
# If it prints "Contracts pallet: NOT FOUND", the build does not include contracts.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${REPO_ROOT}/target/release/parachain-template-node"
WASM_PATH="${REPO_ROOT}/target/release/wbuild/parachain-template-runtime/parachain_template_runtime.wasm"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "Binary not found: $NODE_BIN"
  echo "Run: cargo build --release -p parachain-template-node"
  exit 1
fi

# Method 1: If WASM artifact exists, check metadata (most reliable)
if [[ -f "$WASM_PATH" ]]; then
  if command -v subwasm &>/dev/null; then
    if subwasm meta "$WASM_PATH" 2>/dev/null | grep -qi 'contracts'; then
      echo "Contracts pallet: FOUND in WASM metadata (subwasm)."
      echo "Your binary is correct. If the live chain still has no contracts, Zombienet is using an older binary or cached chain spec."
      exit 0
    fi
  fi
  # Method 1b: wbuild Cargo.lock lists pallet-contracts when runtime was built with it
  WBUILD_LOCK="${REPO_ROOT}/target/release/wbuild/parachain-template-runtime/Cargo.lock"
  if [[ -f "$WBUILD_LOCK" ]] && grep -q 'name = "pallet-contracts"' "$WBUILD_LOCK"; then
    echo "Contracts pallet: FOUND (runtime WASM built with pallet-contracts per wbuild Cargo.lock)."
    echo "Your binary is correct. If the live chain still has no contracts, Zombienet is using an older binary or cached chain spec."
    exit 0
  fi
fi

# Method 2: build-spec output often includes pallet names in genesis
echo "Building chain spec from: $NODE_BIN"
SPEC_JSON="$("$NODE_BIN" build-spec --chain local --disable-default-bootnode 2>/dev/null)" || true
if echo "$SPEC_JSON" | grep -q '"contracts"'; then
  echo "Contracts pallet: FOUND in built runtime (chain spec)."
  echo "Your binary is correct. If the live chain still has no contracts, Zombienet is using an older binary or cached chain spec."
  exit 0
fi
if echo "$SPEC_JSON" | grep -qi 'contracts'; then
  echo "Contracts pallet: FOUND (chain spec, case-insensitive)."
  exit 0
fi

echo "Contracts pallet: NOT FOUND in built runtime."
echo "The release binary does not include pallet-contracts. Check runtime/Cargo.toml features and run:"
echo "  cargo clean -p parachain-template-runtime -p parachain-template-node"
echo "  cargo build --release -p parachain-template-node"
exit 1
