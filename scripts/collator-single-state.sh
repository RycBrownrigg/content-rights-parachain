#!/usr/bin/env bash
# Launch the CCRMS collator with the single-state transaction pool, for the
# open-loop throughput measurements (zombienet-xcm-perf.toml).
#
# The node's default fork-aware pool held transactions back while they were
# being submitted at a steady rate (smoke runs, 15 Oct 2026). Zombienet did not
# pass --pool-type through from the config's args, so it is added here, ahead
# of the `--` that separates the embedded relay-chain node's options.
# Subcommands (export-genesis-state, export-genesis-wasm, build-spec) that
# Zombienet runs before launch are passed through unchanged.
NODE="$(cd "$(dirname "$0")/.." && pwd)/target/release/parachain-template-node"
if [[ "${1:-}" == -* ]]; then
  exec "$NODE" --pool-type=single-state "$@"
fi
exec "$NODE" "$@"
