#!/usr/bin/env bash
# Measurement campaign on the final code (Chapter 7). Run from the repository
# root against a running two-parachain Zombienet (zombienet-xcm-test.toml) with
# HRMP channels open between 100 and 200.
#
#   bash scripts/perf/run-campaign.sh <relay-ws> [paraA-ws] [paraB-ws]
#   QUICK=1 bash scripts/perf/run-campaign.sh <relay-ws>     # short smoke run
#   ONLY=fee-report,open-loop-purchase-views bash scripts/perf/run-campaign.sh <relay-ws>
#                                                            # run only these steps
#
# Each step's console output goes to scripts/perf/results/campaign/<step>.log and
# its JSON to scripts/perf/results/ as before. A failing step does not stop the
# others; the summary at the end lists each step's exit status.
#
# Before the first step and before each open-loop step, scripts/perf/preflight.mjs
# checks that finality is advancing on all three chains and that a transaction
# from //Alice is finalized on both parachains. If it fails, the campaign stops:
# results from a network with stalled finality are not CCRMS results. Start each
# campaign on a freshly spawned network.
set -uo pipefail
cd "$(dirname "$0")/../.."

RELAY_WS="${1:?usage: run-campaign.sh <relay-ws> [paraA-ws] [paraB-ws]}"
PARA_A_WS="${2:-ws://127.0.0.1:9990}"
PARA_B_WS="${3:-ws://127.0.0.1:9991}"
LOG=scripts/perf/results/campaign
mkdir -p "$LOG"

if [[ "${QUICK:-0}" == 1 ]]; then
  RUNS=2; FAIL_RUNS=1; RATES=10,40; DURATION=20; DRAIN=60
else
  RUNS=10; FAIL_RUNS=3; RATES=10,20,40,80,120,160,240; DURATION=60; DRAIN=120
fi

declare -a NAMES STATUS
step() {
  local name="$1"; shift
  if [[ -n "${ONLY:-}" && ",$ONLY," != *",$name,"* ]]; then return; fi
  echo
  echo "=================== $name ==================="
  local t0=$SECONDS
  "$@" 2>&1 | tee "$LOG/$name.log"
  local rc=${PIPESTATUS[0]}
  NAMES+=("$name"); STATUS+=("exit $rc, $((SECONDS - t0)) s")
}

{
  echo "commit $(git rev-parse --short HEAD)$(git diff --quiet || echo ' (dirty)')"
  echo "date   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host   $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m), $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 )) GB"
  echo "mode   $([[ "${QUICK:-0}" == 1 ]] && echo quick || echo full)${ONLY:+, only $ONLY}"
} | tee "$LOG/environment.txt"

preflight() {
  if [[ -n "${ONLY:-}" && "$1" != start && ",$ONLY," != *",$1,"* ]]; then return; fi
  echo
  echo "=================== preflight ($1) ==================="
  node scripts/perf/preflight.mjs "$RELAY_WS" "$PARA_A_WS" "$PARA_B_WS" 2>&1 \
    | grep -v -e REGISTRY -e API/INIT | tee "$LOG/preflight-$1.log"
  if [[ ${PIPESTATUS[0]} -ne 0 ]]; then
    NAMES+=("preflight-$1"); STATUS+=("FAILED: campaign stopped")
    summary
    exit 1
  fi
}
summary() {
  echo
  echo "=================== summary ==================="
  for i in "${!NAMES[@]}"; do printf '  %-26s %s\n' "${NAMES[$i]}" "${STATUS[$i]}"; done | tee "$LOG/summary.txt"
}

preflight start
step fee-report node scripts/perf/fee-report.mjs "$PARA_A_WS"
step xcm-client-latency node scripts/perf/xcm-client-latency.mjs "$PARA_A_WS" "$PARA_B_WS" --runs "$RUNS" --fail-runs "$FAIL_RUNS"
step verify-rights-e2e node scripts/verify-rights-e2e.mjs "$RELAY_WS" "$PARA_A_WS" "$PARA_B_WS"
preflight open-loop-check-access
step open-loop-check-access node scripts/perf/open-loop-throughput.mjs "$PARA_A_WS" --op check_access \
  --rates "$RATES" --duration "$DURATION" --drain "$DRAIN"
preflight open-loop-purchase-views
step open-loop-purchase-views node scripts/perf/open-loop-throughput.mjs "$PARA_A_WS" --op purchase_views \
  --rates "$RATES" --duration "$DURATION" --drain "$DRAIN"

summary
