#!/bin/bash
# Run one full practice trial locally: the kit's real env drives the six practice
# prompts at this entry, the stub gateway answers as a mock OpenRouter, and the
# kit's real scorer grades the export against the practice reference + cassette.
#
# Usage: test/run-practice.sh [trial] [scenario]
#   trial:    trial-0 | trial-1 | trial-2   (default trial-0)
#   scenario: clean | failover | all429     (default clean)
set -u

TRIAL="${1:-trial-0}"
SCENARIO="${2:-clean}"
KIT="${KIT_DIR:-$HOME/workspace/makefun-live-agg-kit/free-model-aggregator-02-kit}"
REPO="$HOME/workspace/makefun-live-agg"
RUN="$REPO/test/runs/$TRIAL-$SCENARIO"
rm -rf "$RUN"
mkdir -p "$RUN/state" "$RUN/cassette/bodies" "$RUN/output" "$RUN/scores"

cleanup() {
  kill -TERM "$STUB_PID" 2>/dev/null
  kill -TERM "$ENV_PID" 2>/dev/null
  wait "$STUB_PID" 2>/dev/null
  wait "$ENV_PID" 2>/dev/null
}
trap cleanup EXIT

STUB_PORT=18080 STUB_CASSETTE_DIR="$RUN/cassette" STUB_SCENARIO="$SCENARIO" \
  node "$REPO/test/stub-gateway.mjs" > "$RUN/stub.log" 2>&1 &
STUB_PID=$!

MAKEFUN_ENV_DATA_DIR="$KIT/practice/$TRIAL/input/env" \
MAKEFUN_STATE_DIR="$RUN/state" \
MAKEFUN_ENV_PORT=18081 \
  node "$KIT/program/env/server.mjs" > "$RUN/env.log" 2>&1 &
ENV_PID=$!

for _ in $(seq 1 100); do [ -f "$RUN/state/ready" ] && break; sleep 0.1; done
[ -f "$RUN/state/ready" ] || { echo "env did not become ready"; exit 1; }

MAKEFUN_PROMPT_FILE="$KIT/practice/$TRIAL/input/prompt.txt" \
MAKEFUN_ENV_URL="http://127.0.0.1:18081" \
OPENAI_BASE_URL="http://127.0.0.1:18080/v1" \
OPENAI_API_KEY="dummy-key" \
ANTHROPIC_API_KEY="dummy-key" \
  node "$REPO/main.ts" > "$RUN/entry.log" 2>&1
ENTRY_CODE=$?
echo "entry exit: $ENTRY_CODE"

kill -TERM "$ENV_PID" 2>/dev/null
wait "$ENV_PID" 2>/dev/null
kill -TERM "$STUB_PID" 2>/dev/null
wait "$STUB_PID" 2>/dev/null
trap - EXIT

cp "$RUN/state/export/state.json" "$RUN/output/state.json"
MAKEFUN_OUTPUT_DIR="$RUN/output" \
MAKEFUN_REFERENCE_DIR="$KIT/practice/$TRIAL/reference" \
MAKEFUN_CASSETTE_DIR="$RUN/cassette" \
MAKEFUN_SCORES_DIR="$RUN/scores" \
  node "$KIT/program/scorer/score.mjs"
echo "--- scores ---"
cat "$RUN/scores/scores.json"
echo "--- checks ---"
cat "$RUN/scores/checks.json"
echo "--- stub calls ---"
cat "$RUN/stub.log"
