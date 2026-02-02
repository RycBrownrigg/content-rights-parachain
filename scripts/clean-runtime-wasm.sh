#!/usr/bin/env bash
# Remove the runtime and node build artifacts so the next build definitely
# recompiles the runtime (including WASM) with current features (e.g. pallet-contracts).
# Run from repo root, then: cargo build --release -p parachain-template-node
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

TARGET="${REPO_ROOT}/target/release"

echo "Removing runtime WASM and node artifacts so next build does a full recompile..."

# Runtime WASM (build script output)
rm -rf "${TARGET}/wbuild/parachain-template-runtime"
# Runtime build script cache (so build.rs runs again and rebuilds WASM)
rm -rf "${TARGET}"/build/parachain_template_runtime-*
# Runtime and node compiled artifacts (so both crates are recompiled)
rm -f "${TARGET}"/deps/libparachain_template_runtime*
rm -f "${TARGET}"/deps/parachain_template_runtime*
rm -f "${TARGET}"/parachain-template-node
rm -f "${TARGET}"/deps/parachain_template_node*

echo "Done. Run: cargo build --release -p parachain-template-node"
echo "Then: ./scripts/verify-runtime-has-contracts.sh"
