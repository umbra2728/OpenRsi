from __future__ import annotations

import os
import shlex
from typing import Any

from .base import JsonAdapter
from ..models import RunSpec, TraceEvent


class CodexAdapter(JsonAdapter):
    name = "codex"

    def command(self, spec: RunSpec, prompt_path: str = "/run/prompt.md") -> list[str]:
        base_url = os.environ.get("OPENROUTER_PROXY_URL", "http://host.docker.internal:1") + "/v1"
        overrides = [
            'model_provider="openrouter"',
            'model_providers.openrouter.name="openrouter"',
            f'model_providers.openrouter.base_url="{base_url}"',
            'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
            'model_providers.openrouter.wire_api="responses"',
        ]
        flags = " ".join(f"-c {shlex.quote(value)}" for value in overrides)
        return ["sh", "-lc", f'exec codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /workspace {flags} --model {spec.model} "$(cat {prompt_path})"']

    def convert(self, seq: int, raw: dict[str, Any]) -> TraceEvent | None:
        typ = str(raw.get("type", ""))
        item = raw.get("item", {})
        item_type = str(item.get("type", "")) if isinstance(item, dict) else ""
        if item_type in {"agent_message", "message"}:
            return self.event(seq, "assistant_msg", raw, text=str(item.get("text") or item.get("content") or ""))
        if item_type in {"reasoning", "analysis"}:
            return self.event(seq, "thinking", raw, text=str(item.get("text") or ""))
        if "command" in item_type or "tool" in item_type:
            kind = "tool_result" if typ.endswith("completed") else "tool_use"
            return self.event(seq, kind, raw, tool=str(item.get("name") or item_type), tool_input=item.get("arguments"), parent_tool_id=item.get("id"))
        return self.event(seq, "status", raw, attributes={"event_type": typ, "item_type": item_type})
