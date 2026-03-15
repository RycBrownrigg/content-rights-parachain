#!/usr/bin/env bash
# Run zombienet from this repo's zombienet/javascript (with @polkadot overrides).
# Expects zombienet and polkadot-sdk inside this repo. Rewrites the config to use
# absolute paths so spawned processes (which run in a temp dir) find the binaries.
#
# Usage (from repo root):
#   ./zombienet-spawn.sh my-content-rights.toml --provider native
#
# Connection tips:
# - Wait 30–60s after spawn (or after you see blocks) before opening Polkadot.js Apps.
# - Connect to the PARACHAIN RPC port from your config (e.g. ws://127.0.0.1:9990 for my-content-rights.toml).
#   The relay (alice/bob) uses different ports and won't show parachain pallets like "contracts".
# - Use the apps on the SAME machine that runs this script (127.0.0.1 = that machine).
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVOKE_CWD="$(pwd)"
ZOMBIENET_JS="${SCRIPT_DIR}/zombienet/javascript"
if [[ ! -d "$ZOMBIENET_JS" ]]; then
  echo "Error: zombienet/javascript not found at $ZOMBIENET_JS" >&2
  echo "Move or clone zombienet into this repo: $SCRIPT_DIR/zombienet" >&2
  exit 1
fi
# Resolve config path
CONFIG_ARG="${1:-}"
if [[ -z "$CONFIG_ARG" || "$CONFIG_ARG" == --* ]]; then
  echo "Usage: $0 <config.toml> [--provider native] ..." >&2
  exit 1
fi
if [[ "$CONFIG_ARG" != /* ]]; then
  CONFIG_ARG="${INVOKE_CWD}/${CONFIG_ARG}"
fi
PROJECT_ROOT="$(cd "$(dirname "$CONFIG_ARG")" && pwd)"
# Zombienet runs spawned commands from a temp dir, so relative paths in the config fail.
# Write a temp config with absolute paths.
TEMP_CONFIG="$(mktemp /tmp/zombienet-XXXXXXXX)"
mv "$TEMP_CONFIG" "${TEMP_CONFIG}.toml"
TEMP_CONFIG="${TEMP_CONFIG}.toml"
trap "rm -f '$TEMP_CONFIG'" EXIT
sed -e "s|polkadot-sdk/target/release|${PROJECT_ROOT}/polkadot-sdk/target/release|g" \
    -e "s|target/release/parachain-template-node|${PROJECT_ROOT}/target/release/parachain-template-node|g" \
    "$CONFIG_ARG" > "$TEMP_CONFIG"
PARACHAIN_BIN="${PROJECT_ROOT}/target/release/parachain-template-node"
echo "Parachain binary (must exist for chain spec + collator): $PARACHAIN_BIN"
shift
exec node "$ZOMBIENET_JS/packages/cli/dist/cli.js" spawn "$TEMP_CONFIG" "$@"
