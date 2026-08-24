#!/usr/bin/env bash
# Run one HarnessOpt optimization in the foreground and archive its exact output
# directory on every terminal outcome. Launch this script under setsid/nohup when
# detachment is desired; keeping the benchmark command foreground here ensures
# Harbor can collect and finalize the session correctly.
#
# Safe by default: without --go it prints the fully-resolved command and exits.
#
#   OPENRSI_GIT_URL=https://github.com/umbra2728/OpenRsi.git \
#   OPENRSI_GIT_REF=<immutable-commit-sha> \
#   scripts/run_harnessopt.sh gaia openai/gpt-5.6-sol --go
set -euo pipefail

TASK="${1:?usage: run_harnessopt.sh <task> <optimizer-model> [--go]}"
OPT_MODEL="${2:?optimizer model id, e.g. openai/gpt-5.6-sol}"
GO="${3:-}"

HARNESSOPT="${HARNESSOPT:-/mnt/storage/harnessopt}"
VERO="${VERO:-$HARNESSOPT/vero/vero}"
HEB="${HEB:-$HARNESSOPT/vero/harness-engineering-bench}"
SECRETS="${SECRETS:-$HARNESSOPT/vero/openrouter.secrets.env}"
UV="${UV:-/mnt/storage/bin/uv}"
RESULTS="${OPENRSI_RESULTS:-$HARNESSOPT/results}"
LIVE_ROOT="${OPENRSI_LIVE_ROOT:-$HARNESSOPT/live}"
TS="$(date +%Y%m%d-%H%M%S)"
MODEL_LABEL="$(printf '%s' "$OPT_MODEL" | tr '/:' '__')"
LABEL="${OPENRSI_RUN_LABEL:-${TASK}__${MODEL_LABEL}__${TS}}"
LIVE="${OPENRSI_LIVE_DIR:-$LIVE_ROOT/$LABEL}"
BUILD="$HEB/$TASK/baseline/build.yaml"

[ -f "$BUILD" ] || { echo "no build.yaml for task '$TASK' at $BUILD" >&2; exit 1; }
[ -f "$SECRETS" ] || { echo "secrets env not found: $SECRETS" >&2; exit 1; }
[ -x "$UV" ] || { echo "uv not executable: $UV" >&2; exit 1; }

: "${OPENRSI_GIT_URL:?set OPENRSI_GIT_URL to the pushed OpenRSI integration remote}"
: "${OPENRSI_GIT_REF:?set OPENRSI_GIT_REF to an immutable integration commit SHA}"

CMD=(
  "$UV" run vero harbor run
  --config "$BUILD"
  --env-file "$SECRETS"
  --environment docker
  --agent openrsi
  --model "$OPT_MODEL"
  --param "optimizer_model=$OPT_MODEL"
  --param "wandb_run=$LABEL"
  --param "inner_env=modal"
  --yes
  -o "$LIVE"
)

echo "=== HarnessOpt run ==="
echo "label=$LABEL"
echo "task=$TASK"
echo "optimizer=$OPT_MODEL"
echo "target(pinned)=$(grep -E '^model:' "$BUILD" | head -1)"
echo "build=$BUILD"
echo "live=$LIVE"
echo "results=$RESULTS"
echo "OPENRSI_GIT_URL=$OPENRSI_GIT_URL"
echo "OPENRSI_GIT_REF=$OPENRSI_GIT_REF"
echo "generations=${OPENRSI_GENERATIONS:-6} dev_subset=${OPENRSI_DEV_SUBSET:-8} reserve_val=${OPENRSI_RESERVE_VAL:-8}"
printf 'cmd: '; printf '%q ' "${CMD[@]}"; echo

if [ "$GO" != "--go" ]; then
  echo "[dry] not launching; pass --go to spend Modal and model budget."
  exit 0
fi

mkdir -p "$LIVE_ROOT" "$RESULTS"
rm -rf "$LIVE"
mkdir -p "$LIVE"
cp "$BUILD" "$LIVE/build.used.yaml"
{
  echo "label=$LABEL"
  echo "started=$(date -Is)"
  echo "task=$TASK"
  echo "optimizer_model=$OPT_MODEL"
  echo "openrsi_git_url=$OPENRSI_GIT_URL"
  echo "openrsi_git_ref=$OPENRSI_GIT_REF"
  echo "generations=${OPENRSI_GENERATIONS:-6}"
  echo "dev_subset=${OPENRSI_DEV_SUBSET:-8}"
  echo "reserve_val=${OPENRSI_RESERVE_VAL:-8}"
} > "$LIVE/launch.env"

archive_once() {
  local rc="$1"
  trap - EXIT INT TERM
  echo "=== archiving terminal state (exit=$rc) ==="
  if [ -x "$HARNESSOPT/openrsi/scripts/archive_run.sh" ]; then
    OPENRSI_RESULTS="$RESULTS" \
      "$HARNESSOPT/openrsi/scripts/archive_run.sh" "$LIVE" "$LABEL" || true
  else
    echo "archive script missing: $HARNESSOPT/openrsi/scripts/archive_run.sh" >&2
  fi
  return "$rc"
}
trap 'rc=$?; archive_once "$rc"; exit "$rc"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$VERO"
set -a
# shellcheck disable=SC1090
source "$SECRETS"
set +a
export OPENRSI_GIT_URL OPENRSI_GIT_REF

echo "RUN-START $(date -Is)"
"${CMD[@]}"
echo "RUN-DONE exit=0 $(date -Is)"
