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
#
# Build-config selection (paper-shaped grid): the GAIA cell must use the
# non-functional SHELL seed (baseline 0), not the working stateful Responses
# seed. Point at it without editing canonical YAML via either:
#   OPENRSI_BUILD_CONFIG=<abs-or-HEB-relative path to a build.yaml>
#   OPENRSI_BUILD_VARIANT=shell   # resolves <task>/baseline/build.shell.yaml
# Default remains <task>/baseline/build.yaml so existing calls are unchanged.
set -euo pipefail

TASK="${1:?usage: run_harnessopt.sh <task> <optimizer-model> [--go]}"
OPT_MODEL="${2:?optimizer model id, e.g. openai/gpt-5.6-sol}"
GO="${3:-}"

HARNESSOPT="${HARNESSOPT:-/mnt/storage/harnessopt}"
ENV_SH="${HARNESSOPT_ENV:-$HARNESSOPT/env.sh}"
# env.sh puts the storage-local uv/uvx toolchain on PATH. VeRO invokes uvx
# internally after compiling the Harbor task, so setting UV alone is insufficient.
if [ -f "$ENV_SH" ]; then
  # shellcheck disable=SC1090
  source "$ENV_SH"
fi
VERO="${VERO:-$HARNESSOPT/vero/vero}"
HEB="${HEB:-$HARNESSOPT/vero/harness-engineering-bench}"
SECRETS="${SECRETS:-$HARNESSOPT/vero/openrouter.secrets.env}"
UV="${UV:-/mnt/storage/bin/uv}"
RESULTS="${OPENRSI_RESULTS:-$HARNESSOPT/results}"
LIVE_ROOT="${OPENRSI_LIVE_ROOT:-$HARNESSOPT/live}"
TS="$(date +%Y%m%d-%H%M%S)"
MODEL_LABEL="$(printf '%s' "$OPT_MODEL" | tr '/:' '__')"

# Resolve the build config. Priority: explicit OPENRSI_BUILD_CONFIG, then a named
# OPENRSI_BUILD_VARIANT (e.g. shell -> build.shell.yaml), then the canonical file.
if [ -n "${OPENRSI_BUILD_CONFIG:-}" ]; then
  case "$OPENRSI_BUILD_CONFIG" in
    /*) BUILD="$OPENRSI_BUILD_CONFIG" ;;
    *)  BUILD="$HEB/$OPENRSI_BUILD_CONFIG" ;;
  esac
elif [ -n "${OPENRSI_BUILD_VARIANT:-}" ]; then
  BUILD="$HEB/$TASK/baseline/build.${OPENRSI_BUILD_VARIANT}.yaml"
else
  BUILD="$HEB/$TASK/baseline/build.yaml"
fi
BUILD_BASE="$(basename "$BUILD" .yaml)"
# Distinguish variant runs in the label so a shell-seed run never collides with a
# working-seed run in results/ (e.g. gaia__build.shell__gpt-5.6-sol__<ts>).
if [ "$BUILD_BASE" = "build" ]; then
  CFG_TAG=""
else
  CFG_TAG="$(printf '%s' "$BUILD_BASE" | sed 's/^build\.//')__"
fi
LABEL="${OPENRSI_RUN_LABEL:-${TASK}__${CFG_TAG}${MODEL_LABEL}__${TS}}"
LIVE="${OPENRSI_LIVE_DIR:-$LIVE_ROOT/$LABEL}"

[ -f "$BUILD" ] || {
  echo "no build config for task '$TASK' at $BUILD" >&2
  echo "  (set OPENRSI_BUILD_CONFIG or OPENRSI_BUILD_VARIANT to override)" >&2
  exit 1
}
[ -f "$SECRETS" ] || {
  echo "secrets env not found: $SECRETS" >&2
  exit 1
}
[ -x "$UV" ] || {
  echo "uv not executable: $UV" >&2
  exit 1
}

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
echo "build_sha256=$( (sha256sum "$BUILD" 2>/dev/null || shasum -a 256 "$BUILD") | awk '{print $1}')"
echo "baseline_reward(pinned)=$(grep -E '^\s*baseline_reward:' "$BUILD" | head -1 | sed 's/^[[:space:]]*//')"
echo "live=$LIVE"
echo "results=$RESULTS"
echo "OPENRSI_GIT_URL=$OPENRSI_GIT_URL"
echo "OPENRSI_GIT_REF=$OPENRSI_GIT_REF"
echo "generations=${OPENRSI_GENERATIONS:-6} dev_subset=${OPENRSI_DEV_SUBSET:-8} reserve_val=${OPENRSI_RESERVE_VAL:-8}"
printf 'cmd: '
printf '%q ' "${CMD[@]}"
echo

if [ "$GO" != "--go" ]; then
  echo "[dry] not launching; pass --go to spend Modal and model budget."
  exit 0
fi

mkdir -p "$LIVE_ROOT" "$RESULTS"
rm -rf "$LIVE"
mkdir -p "$LIVE"
cp "$BUILD" "$LIVE/build.used.yaml"
BUILD_SHA="$( (sha256sum "$BUILD" 2>/dev/null || shasum -a 256 "$BUILD") | awk '{print $1}')"
{
  echo "label=$LABEL"
  echo "started=$(date -Is)"
  echo "task=$TASK"
  echo "optimizer_model=$OPT_MODEL"
  echo "build_config=$BUILD"
  echo "build_config_basename=$BUILD_BASE"
  echo "build_config_sha256=$BUILD_SHA"
  echo "openrsi_git_url=$OPENRSI_GIT_URL"
  echo "openrsi_git_ref=$OPENRSI_GIT_REF"
  echo "generations=${OPENRSI_GENERATIONS:-6}"
  echo "dev_subset=${OPENRSI_DEV_SUBSET:-8}"
  echo "reserve_val=${OPENRSI_RESERVE_VAL:-8}"
  echo "finalists=${OPENRSI_FINALISTS:-3}"
  echo "val_select_cases=${OPENRSI_VAL_SELECT_CASES:-auto}"
  echo "val_confirm_cases=${OPENRSI_VAL_CONFIRM_CASES:-auto}"
} >"$LIVE/launch.env"

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
