#!/usr/bin/env bash
# Verify the ink! development environment: rust-src, wasm32 target, cargo-contract.
# Run from anywhere. Exit 0 if all OK, 1 if something is missing.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OK=0
MISSING=0

echo "=== ink! environment check ==="
echo ""

# rust-src
if rustup component list --installed 2>/dev/null | grep -q '^rust-src'; then
  echo "  rust-src:        OK"
  ((OK++)) || true
else
  echo "  rust-src:        MISSING (run: rustup component add rust-src)"
  ((MISSING++)) || true
fi

# wasm32 target (either form)
if rustup target list --installed 2>/dev/null | grep -q 'wasm32'; then
  echo "  wasm32 target:   OK"
  ((OK++)) || true
else
  echo "  wasm32 target:   MISSING"
  echo "                  Rust 1.84+: rustup target add wasm32v1-none"
  echo "                  Older:      rustup target add wasm32-unknown-unknown"
  ((MISSING++)) || true
fi

# cargo-contract
if command -v cargo-contract &>/dev/null; then
  echo "  cargo-contract:  OK ($(cargo contract --version 2>/dev/null || true))"
  ((OK++)) || true
else
  echo "  cargo-contract:  MISSING (run: cargo install --force --locked cargo-contract)"
  echo "                  Prerequisite: rustup component add rust-src"
  ((MISSING++)) || true
fi

echo ""
if [[ "$MISSING" -gt 0 ]]; then
  echo "Fix the missing items above, then run this script again."
  echo "See INK_SETUP.md in the repo root for full setup steps."
  exit 1
fi
echo "ink! environment is ready. See INK_SETUP.md for usage and deploy steps."
exit 0
