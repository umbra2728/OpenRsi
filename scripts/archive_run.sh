#!/usr/bin/env bash
# Archive a finished Harbor run into a durable, findable per-run results dir so
# nothing is lost (Harbor writes to /tmp, which is ephemeral) and everything a
# later analysis needs to build graphs is in one place.
#
#   scripts/archive_run.sh <harbor_-o_dir> <label>
#   e.g. scripts/archive_run.sh /tmp/gaia-smoke gaia__gpt-5.6-sol
#
# Collects, per run:
#   reward.json, finalization.json      — the trusted held-out result
#   openrsi.jsonl, openrsi.txt          — the optimizer loop's structured log
#   usage.json                          — the gateway TOKEN METER (producer/eval/finalization) → cost graphs
#   database.json                       — every evaluation + score → score/curve graphs
#   candidates.git/                     — every candidate commit → code-evolution graphs
#   session.tar.gz, session-rescue.tar.gz, config.json, job.log — full raw record
set -euo pipefail

SRC="${1:?usage: archive_run.sh <harbor -o dir> <label>}"
LABEL="${2:?label, e.g. gaia__gpt-5.6-sol}"
RESULTS="${OPENRSI_RESULTS:-/mnt/storage/harnessopt/results}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$RESULTS/${LABEL}__$TS"
mkdir -p "$OUT"

# flat files (first match wins)
for name in reward.json finalization.json openrsi.jsonl openrsi.txt config.json job.log; do
  f="$(find "$SRC" -name "$name" 2>/dev/null | head -1 || true)"
  [ -n "$f" ] && cp "$f" "$OUT/" 2>/dev/null || true
done

# the big verifier session archive holds usage.json + database.json + candidates
SESS="$(find "$SRC" -name 'session.tar.gz' 2>/dev/null | head -1 || true)"
RESCUE="$(find "$SRC" -name 'session-rescue.tar.gz' 2>/dev/null | head -1 || true)"
[ -n "$SESS" ] && cp "$SESS" "$OUT/" || true
[ -n "$RESCUE" ] && cp "$RESCUE" "$OUT/" || true

# Extract rescue first, then the completed session. Both archives use the same
# `session/` paths; extracting rescue last used to overwrite the complete
# database with a search-only snapshot and silently drop the held-out test
# evaluation. The completed session is authoritative whenever it exists.
TMP="$(mktemp -d)"
for A in "$RESCUE" "$SESS"; do
  [ -n "$A" ] || continue
  tar xzf "$A" -C "$TMP" 2>/dev/null || true
done
U="$(find "$TMP" -path '*inference/usage.json' 2>/dev/null | head -1 || true)"
DB="$(find "$TMP" -name 'database.json' 2>/dev/null | head -1 || true)"
GIT="$(find "$TMP" -name 'repository.git' -type d 2>/dev/null | head -1 || true)"
[ -n "$U" ] && cp "$U" "$OUT/usage.json" || true
[ -n "$DB" ] && cp "$DB" "$OUT/database.json" || true
[ -n "$GIT" ] && cp -r "$GIT" "$OUT/candidates.git" || true
rm -rf "$TMP"

# a tiny manifest for quick scanning
{
  echo "label=$LABEL"
  echo "archived=$TS"
  echo "source=$SRC"
  echo "reward=$(cat "$OUT/reward.json" 2>/dev/null | tr -d '[:space:]')"
  echo "files:"; ls -la "$OUT" | sed 's/^/  /'
} > "$OUT/MANIFEST.txt"

echo "archived -> $OUT"
ls -la "$OUT"
