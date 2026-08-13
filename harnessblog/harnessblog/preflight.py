from __future__ import annotations

import json
import os
import shlex
import subprocess
from dataclasses import dataclass, asdict


@dataclass
class Check:
    name: str
    ok: bool
    detail: str


def _remote(host: str, command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["ssh", "-o", "BatchMode=yes", host, command], text=True, capture_output=True, check=False)


def run_preflight(host: str) -> list[Check]:
    checks: list[Check] = []
    commands = {
        "ssh": "uname -m",
        "docker": "docker version --format '{{.Server.Version}}'",
        "nvidia": "nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader",
        "nvidia-runtime": "docker info --format '{{json .Runtimes}}'",
        "disk": "df -Pk . | tail -1 | awk '{print $4}'",
    }
    for name, command in commands.items():
        result = _remote(host, command)
        detail = (result.stdout or result.stderr).strip()
        ok = result.returncode == 0 and bool(detail)
        if name == "nvidia-runtime": ok = ok and '"nvidia"' in detail
        if name == "disk" and ok: ok = int(detail) > 100 * 1024 * 1024
        checks.append(Check(name, ok, detail[:1000]))
    for env_name in ("OPENROUTER_API_KEY", "TRACEHOUSE_API_KEY"):
        present = bool(os.getenv(env_name))
        checks.append(Check(env_name.lower(), present, "set" if present else "missing (required for paid runs)"))
    return checks


def print_checks(checks: list[Check]) -> None:
    print(json.dumps([asdict(c) for c in checks], indent=2))
