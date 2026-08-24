#!/usr/bin/env bash
# Register the OpenRSI Harbor optimizer agent into the installed `harbor` package
# so `vero harbor run --agent openrsi` resolves it.
#
# Idempotent. Because it edits files inside the venv's site-packages, re-run it
# after any `harbor` reinstall/upgrade. Verifiable WITHOUT a bench run: it ends by
# importing the class through harbor's own factory.
#
#   scripts/register_openrsi_agent.sh /mnt/storage/harnessopt/vero/vero
set -euo pipefail

VENV_PROJ="${1:-/mnt/storage/harnessopt/vero/vero}"
ADAPTER_SRC="$(cd "$(dirname "$0")/.." && pwd)/agent/harbor/openrsi_agent.py"
UV="${UV:-/mnt/storage/bin/uv}"

cd "$VENV_PROJ"
HP="$("$UV" run python -c 'import harbor,inspect,os;print(os.path.dirname(inspect.getfile(harbor)))')"
echo "harbor at: $HP"

cp "$ADAPTER_SRC" "$HP/agents/installed/openrsi.py"
echo "copied adapter -> $HP/agents/installed/openrsi.py"

"$UV" run python - "$HP" <<'PY'
import sys, re, pathlib
hp = pathlib.Path(sys.argv[1])

# 1) AgentName enum: add OPENRSI = "openrsi" if missing.
name_py = hp / "models/agent/name.py"
s = name_py.read_text()
if 'OPENRSI' not in s:
    s = re.sub(r'(class AgentName\(str, Enum\):\n)', r'\1    OPENRSI = "openrsi"\n', s, count=1)
    name_py.write_text(s)
    print("patched AgentName enum")
else:
    print("AgentName.OPENRSI already present")

# 2) factory map: AgentName.OPENRSI -> import path, if missing.
fac = hp / "agents/factory.py"
f = fac.read_text()
if 'installed.openrsi:OpenRsi' not in f:
    # insert after the CLAUDE_CODE mapping line (stable anchor).
    anchor = re.search(r'\n(\s*)AgentName\.CLAUDE_CODE:\s*"[^"]+",\n', f)
    if not anchor:
        raise SystemExit("could not find factory map anchor (CLAUDE_CODE)")
    indent = anchor.group(1)
    ins = f'{indent}AgentName.OPENRSI: "harbor.agents.installed.openrsi:OpenRsi",\n'
    f = f[: anchor.end()] + ins + f[anchor.end():]
    fac.write_text(f)
    print("patched factory map")
else:
    print("factory map already has openrsi")
PY

echo "=== verify: harbor loads the openrsi agent class ==="
"$UV" run python - <<'PY'
from harbor.models.agent.name import AgentName
from harbor.utils.import_path import import_class
assert "openrsi" in AgentName.values(), AgentName.values()
cls = import_class("harbor.agents.installed.openrsi:OpenRsi", label="agent")
assert cls.name() == "openrsi", cls.name()
print("OK: AgentName.OPENRSI registered and class import_path resolves ->", cls.__name__)
PY
echo "registration complete."
