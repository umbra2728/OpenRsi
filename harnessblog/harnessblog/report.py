from __future__ import annotations

import json
from pathlib import Path


def render(state_file: Path) -> str:
    state = json.loads(state_file.read_text())
    lines = ["# Harness benchmark report", "", "| Run | Status | Score | Pass | Cost |", "|---|---:|---:|---:|---:|"]
    for run_id, value in sorted(state.get("results", {}).items()):
        lines.append(f"| {run_id} | {value.get('status')} | {value.get('score', 0):.1f} | {value.get('passed', False)} | ${value.get('usage', {}).get('cost_usd', 0):.2f} |")
    return "\n".join(lines) + "\n"

