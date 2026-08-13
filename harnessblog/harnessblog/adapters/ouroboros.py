from __future__ import annotations

from typing import Any

from .base import JsonAdapter
from ..models import RunSpec, TraceEvent


class OuroborosAdapter(JsonAdapter):
    name = "ouroboros"

    def command(self, spec: RunSpec, prompt_path: str = "/run/prompt.md") -> list[str]:
        model = f"openai-compatible::{spec.model}"
        return ["sh", "-lc", (
            "git init -q /workspace && git -C /workspace config user.email benchmark@local "
            "&& git -C /workspace config user.name benchmark "
            "&& printf '.venv/\\nvenv/\\n__pycache__/\\n*.pyc\\n' > /workspace/.gitignore "
            "&& git -C /workspace add config.json .gitignore "
            "&& git -C /workspace commit -q -m benchmark-baseline "
            "&& { printf '%s\\n\\n' "
            "'Operational requirement: Treat /workspace itself as the project root. Do not create a nested project directory. Every deliverable, including run.sh and output/, must be directly under /workspace.'; "
            f"cat {prompt_path}; }} > /home/agent/ouroboros-prompt.md "
            f"&& export OUROBOROS_MODEL='{model}' OUROBOROS_MODEL_HEAVY='{model}' "
            f"OUROBOROS_MODEL_LIGHT='{model}' OUROBOROS_MODEL_FALLBACKS='' "
            "OUROBOROS_REVIEW_MODELS='' OUROBOROS_RUNTIME_MODE=advanced "
            "OUROBOROS_CONTEXT_MODE=low OUROBOROS_POST_TASK_EVOLUTION=false "
            "OUROBOROS_MAIN_WEB_SEARCH=off OUROBOROS_GENERATIVE_PROBE=0 "
            "OUROBOROS_PER_TASK_COST_USD=4.5 TOTAL_BUDGET=4.5 "
            "OPENAI_COMPATIBLE_API_KEY=\"$OPENAI_API_KEY\" "
            "OPENAI_COMPATIBLE_BASE_URL=\"$OPENAI_BASE_URL\" "
            "OUROBOROS_APP_ROOT=/home/agent/Ouroboros OUROBOROS_REPO_DIR=/opt/ouroboros "
            "OUROBOROS_DATA_DIR=/home/agent/Ouroboros/data "
            "&& { ouroboros server >/home/agent/ouroboros-server.log 2>&1 & server_pid=$!; "
            "for i in $(seq 1 120); do ouroboros status >/dev/null 2>&1 && break; sleep 1; done; "
            "ouroboros status >/dev/null 2>&1 || { cat /home/agent/ouroboros-server.log >&2; kill $server_pid; exit 70; }; "
            "sleep 15; "
            f"ouroboros run --jsonl --timeout 3500 --workspace /workspace "
            "--memory-mode empty --prompt-file /home/agent/ouroboros-prompt.md; "
            "run_rc=$?; kill $server_pid >/dev/null 2>&1 || true; "
            "if [ $run_rc -ne 0 ]; then echo '{\"type\":\"status\",\"message\":\"ouroboros exited nonzero; evaluator will inspect workspace artifacts\"}'; fi; "
            "exit 0; }"
        )]

    def convert(self, seq: int, raw: dict[str, Any]) -> TraceEvent | None:
        typ = str(raw.get("type") or raw.get("event") or raw.get("status") or "status")
        text = raw.get("text") or raw.get("message") or raw.get("result") or raw.get("detail")
        tool = raw.get("tool") or raw.get("tool_name")
        if tool:
            kind = "tool_result" if "result" in typ or "complete" in typ else "tool_use"
            return self.event(seq, kind, raw, tool=str(tool), text=str(text or ""), tool_input=raw.get("input") or raw.get("arguments"))
        if "think" in typ or "reason" in typ:
            return self.event(seq, "thinking", raw, text=str(text or ""))
        if text and any(x in typ for x in ("message", "result", "complete", "final", "progress")):
            return self.event(seq, "assistant_msg", raw, text=str(text))
        return self.event(seq, "status", raw, attributes={"event_type": typ})
