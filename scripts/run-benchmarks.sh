#!/usr/bin/env bash
# Run FRAME benchmarks for the three CCRMS pallets and regenerate their weights.rs
# (Finding L). Run from the repository root on the machine whose weights you
# report; benchmarks measure the hardware they run on.
#
#   bash scripts/run-benchmarks.sh            # 50 steps, 20 repeats (final weights)
#   STEPS=5 REPEAT=2 bash scripts/run-benchmarks.sh   # quick trial run
#
# The raw benchmark output (min/median/max per component value) is kept in
# scripts/perf/results/benchmarks/ for the dissertation tables.
set -euo pipefail
cd "$(dirname "$0")/.."

STEPS="${STEPS:-50}"
REPEAT="${REPEAT:-20}"
# pallet-revive's own benchmark fixtures need a RISC-V toolchain; CCRMS does
# not benchmark pallet-revive, so skip building them.
export SKIP_PALLET_REVIVE_FIXTURES=1

cargo build --release -p parachain-template-node --features runtime-benchmarks

NODE=target/release/parachain-template-node
WASM=target/release/wbuild/parachain-template-runtime/parachain_template_runtime.compact.compressed.wasm
TEMPLATE=.maintain/frame-weight-template.hbs
OUT=scripts/perf/results/benchmarks
mkdir -p "$OUT"

for spec in \
  "pallet_content_rights:pallets/content-rights/src/weights.rs" \
  "pallet_rights_verifier:pallets/rights-verifier/src/weights.rs" \
  "pallet_rights_client:pallets/rights-client/src/weights.rs"; do
  pallet="${spec%%:*}"
  weights="${spec#*:}"
  echo "== $pallet (steps $STEPS, repeat $REPEAT) =="
  "$NODE" benchmark pallet \
    --runtime "$WASM" \
    --genesis-builder=runtime \
    --genesis-builder-preset=development \
    --pallet "$pallet" \
    --extrinsic '*' \
    --steps "$STEPS" \
    --repeat "$REPEAT" \
    --template "$TEMPLATE" \
    --output "$weights" \
    --json-file "$OUT/$pallet.json" \
    2>&1 | tee "$OUT/$pallet.txt"
done

echo
echo "Weights written. Next: cargo test -p pallet-content-rights -p pallet-rights-verifier -p pallet-rights-client -p content-rights-xcm-tests"
