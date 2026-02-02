#!/usr/bin/env bash
# Show which process is listening on the parachain RPC port (9990).
# Run after Zombienet has started. Confirms which binary is serving the chain.
set -e
PORT="${1:-9990}"
echo "=== Port $PORT (parachain RPC) ==="
echo ""
echo "Process(es) listening on port $PORT:"
if command -v lsof &>/dev/null; then
  if ! lsof -i ":$PORT" 2>/dev/null; then
    echo "  (none)"
    echo ""
    echo "If Polkadot.js Apps shows 'Initializing connection' and never connects:"
    echo "  - The parachain collator may not have started or may have crashed."
    echo "  - Check the collator log: in the terminal where you ran zombienet-spawn.sh,"
    echo "    look for a line like 'Pod collator01-100' and a log path (e.g. /tmp/zombie-*/collator01-100.log)."
    echo "  - Or find the zombie temp dir: ls -la /tmp/zombie-* 2>/dev/null || ls -la /var/folders/.../zombie-* 2>/dev/null"
    echo "    then tail -f <that_dir>/collator01-100.log"
    exit 0
  fi
elif command -v ss &>/dev/null; then
  if ! ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
    echo "  (none)"
    echo ""
    echo "If Polkadot.js Apps shows 'Initializing connection' and never connects:"
    echo "  - The parachain collator may not have started or may have crashed."
    echo "  - Check the collator log in the zombienet temp dir (see path in spawn terminal)."
    exit 0
  fi
  ss -tlnp 2>/dev/null | grep ":$PORT "
else
  echo "  Install lsof or ss to check."
  exit 1
fi
echo ""
echo "To see full command and start time of the process above, run:"
echo "  ps -p <PID> -o lstart,args"
echo "(Replace <PID> with the PID from the output above.)"
