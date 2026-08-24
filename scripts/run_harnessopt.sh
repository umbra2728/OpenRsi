#!/usr/bin/env bash
# Launch one HarnessOpt run: OpenRSI optimizing a target agent on a HEB task,
# then archive EVERYTHING durably (nothing overwritten between runs).
#
# Defaults to --dry (prints the command, runs nothing) so it is safe to stage.
# Drop --dry only when you intend to spend Modal + OpenRouter budget.
#
#   scripts/run_harnessopt.sh gaia anthropic/claude-opus-5 [--go]
#
# Model routing: the gateway upstream is OpenRouter (OpenAI-compatible). optimizer_model
# is a build param; the pinned TARGET model is remapped to its OpenRouter id via a
# per-task overlay (see MODEL_MAP below) — validate the pairing with
# `vero/examples/harness-conformance` before the first real run.
set -euo pipefail

TASK="${1:?usage: run_harnessopt.sh <task> <optimizer-model> [--go]}"
OPT_MODEL="${2:?optimizer model id, e.g. anthropic/claude-opus-5}"
GO="${3:-}"

HARNESSOPT=/mnt/storage/harnessopt
VERO="$HARNESSOPT/vero/vero"
HEB="$HARNESSOPT/vero/harness-engineering-bench"
SECRETS="$HARNESSOPT/vero/openrouter.secrets.env"
UV=/mnt/storage/bin/uv
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$HARNESSOPT/results/${TASK}__$(echo "$OPT_MODEL" | tr '/:' '__')__$TS"

BUILD="$HEB/$TASK/baseline/build.yaml"
[ -f "$BUILD" ] || { echo "no build.yaml for task '$TASK' at $BUILD"; exit 1; }

# The integration branch must be reachable by the in-container adapter (git clone).
: "${OPENRSI_GIT_URL:?set OPENRSI_GIT_URL to the pushed OpenRSI integration remote}"
: "${OPENRSI_GIT_REF:=main}"

mkdir -p "$OUT"
cp "$BUILD" "$OUT/build.used.yaml"

CMD=( "$UV" run vero harbor run
  --config "$BUILD"
  --agent openrsi
  --model "$OPT_MODEL"
  --param "optimizer_model=$OPT_MODEL"
  --param "wandb_run=${TASK}__$(echo "$OPT_MODEL" | tr '/:' '__')"
  --env-file "$SECRETS" )

echo "=== HarnessOpt run ==="
echo "task=$TASK  optimizer=$OPT_MODEL  target(pinned)=$(grep -E '^model:' "$BUILD" | head -1)"
echo "results -> $OUT"
echo "OPENRSI_GIT_URL=$OPENRSI_GIT_URL  ref=$OPENRSI_GIT_REF"
printf 'cmd: '; printf '%q ' "${CMD[@]}"; echo

if [ "$GO" != "--go" ]; then
  echo "[dry] not launching (pass --go to spend budget). Command staged above."
  exit 0
fi

cd "$VERO"
set -a; source "$SECRETS"; set +a
export OPENRSI_GIT_URL OPENRSI_GIT_REF
"${CMD[@]}" 2>&1 | tee "$OUT/run.log"

# Archive durable artifacts (candidate repo, scores DB, gateway token meter, traces).
echo "=== archiving to $OUT ==="
JOBS_DIR="$(ls -dt "$VERO"/jobs/*/ 2>/dev/null | head -1 || true)"
if [ -n "$JOBS_DIR" ]; then
  cp -r "$JOBS_DIR" "$OUT/jobs" || true
  find "$JOBS_DIR" -name 'usage.json' -exec cp {} "$OUT/" \; 2>/dev/null || true
  find "$JOBS_DIR" -name 'database.json' -exec cp {} "$OUT/" \; 2>/dev/null || true
  find "$JOBS_DIR" -name '*session*.tar.gz' -exec cp {} "$OUT/" \; 2>/dev/null || true
fi
echo "done: $OUT"
