#!/usr/bin/env bash
# Register the OpenRSI Harbor optimizer agent in BOTH Harbor installations used
# by VeRO:
#   1. the project's normal uv environment;
#   2. the ephemeral `uvx --from harbor[modal]==0.20.0` environment that
#      `vero harbor run` actually launches.
#
# Idempotent. Re-run after any Harbor/uv cache reinstall or refresh.
#
#   scripts/register_openrsi_agent.sh /mnt/storage/harnessopt/vero/vero
set -euo pipefail

VENV_PROJ="${1:-/mnt/storage/harnessopt/vero/vero}"
ADAPTER_SRC="$(cd "$(dirname "$0")/.." && pwd)/agent/harbor/openrsi_agent.py"
UV="${UV:-/mnt/storage/bin/uv}"
UVX="${UVX:-${UV}x}"
HARBOR_REQUIREMENT="${HARBOR_REQUIREMENT:-harbor[modal]==0.20.0}"
VENV_PY="$VENV_PROJ/.venv/bin/python"

[ -f "$ADAPTER_SRC" ] || { echo "adapter not found: $ADAPTER_SRC" >&2; exit 1; }
[ -x "$UV" ] || { echo "uv not executable: $UV" >&2; exit 1; }
[ -x "$UVX" ] || { echo "uvx not executable: $UVX" >&2; exit 1; }
[ -x "$VENV_PY" ] || { echo "project python not executable: $VENV_PY" >&2; exit 1; }

cd "$VENV_PROJ"
VENV_HP="$("$UV" run python -c 'import harbor,inspect,os; print(os.path.dirname(inspect.getfile(harbor)))')"
UVX_HP="$("$UVX" --python "$VENV_PY" --from "$HARBOR_REQUIREMENT" python -c 'import harbor,inspect,os; print(os.path.dirname(inspect.getfile(harbor)))')"

# uv may hardlink package files between these trees, but newly-created files are
# not shared. Always install and patch each distinct package directory explicitly.
mapfile -t HARBOR_PATHS < <(printf '%s\n%s\n' "$VENV_HP" "$UVX_HP" | awk 'NF && !seen[$0]++')

patch_harbor() {
  local hp="$1"
  echo "registering OpenRSI in: $hp"
  install -m 0644 "$ADAPTER_SRC" "$hp/agents/installed/openrsi.py"

  "$VENV_PY" - "$hp" <<'PY'
import pathlib
import re
import sys

hp = pathlib.Path(sys.argv[1])

name_py = hp / "models/agent/name.py"
s = name_py.read_text()
if 'OPENRSI = "openrsi"' not in s:
    s = re.sub(
        r'(class AgentName\(str, Enum\):\n)',
        r'\1    OPENRSI = "openrsi"\n',
        s,
        count=1,
    )
    name_py.write_text(s)
    print("  patched AgentName enum")
else:
    print("  AgentName.OPENRSI already present")

factory_py = hp / "agents/factory.py"
f = factory_py.read_text()
if 'installed.openrsi:OpenRsi' not in f:
    anchor = re.search(r'\n(\s*)AgentName\.CLAUDE_CODE:\s*"[^"]+",\n', f)
    if not anchor:
        raise SystemExit(f"could not find factory map anchor in {factory_py}")
    indent = anchor.group(1)
    insertion = f'{indent}AgentName.OPENRSI: "harbor.agents.installed.openrsi:OpenRsi",\n'
    f = f[:anchor.end()] + insertion + f[anchor.end():]
    factory_py.write_text(f)
    print("  patched factory map")
else:
    print("  factory map already has OpenRSI")
PY
}

for hp in "${HARBOR_PATHS[@]}"; do
  patch_harbor "$hp"
done

echo "=== verify project Harbor ==="
"$UV" run python - <<'PY'
from harbor.models.agent.name import AgentName
from harbor.utils.import_path import import_class

assert "openrsi" in AgentName.values(), AgentName.values()
cls = import_class("harbor.agents.installed.openrsi:OpenRsi", label="agent")
assert cls.name() == "openrsi", cls.name()
print("OK project Harbor:", cls.__name__)
PY

echo "=== verify uvx Harbor (the runtime used by vero harbor run) ==="
"$UVX" --python "$VENV_PY" --from "$HARBOR_REQUIREMENT" python - <<'PY'
from harbor.models.agent.name import AgentName
from harbor.utils.import_path import import_class

assert "openrsi" in AgentName.values(), AgentName.values()
cls = import_class("harbor.agents.installed.openrsi:OpenRsi", label="agent")
assert cls.name() == "openrsi", cls.name()
print("OK uvx Harbor:", cls.__name__)
PY

echo "registration complete: ${#HARBOR_PATHS[@]} Harbor package path(s) updated."
