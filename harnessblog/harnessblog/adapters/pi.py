from __future__ import annotations

from typing import Any

from .base import JsonAdapter
from ..models import RunSpec, TraceEvent


class PiAdapter(JsonAdapter):
    name = "pi"

    def command(self, spec: RunSpec, prompt_path: str = "/run/prompt.md") -> list[str]:
        return ["sh", "-lc", f'exec pi --mode json --provider openrouter --model {spec.model} --no-session -p "$(cat {prompt_path})"']

    def convert(self, seq: int, raw: dict[str, Any]) -> TraceEvent | None:
        typ = str(raw.get("type", ""))
        message = raw.get("message") or raw.get("content") or {}
        role = message.get("role") if isinstance(message, dict) else None
        if typ in {"assistant_message", "message_end"} or role == "assistant":
            text = message.get("content") if isinstance(message, dict) else message
            return self.event(seq, "assistant_msg", raw, text=str(text))
        if "tool" in typ:
            kind = "tool_result" if "result" in typ else "tool_use"
            return self.event(seq, kind, raw, tool=str(raw.get("toolName") or raw.get("name") or "unknown"), tool_input=raw.get("input"))
        if "thinking" in typ:
            return self.event(seq, "thinking", raw, text=str(raw.get("text") or raw.get("content") or ""))
        return self.event(seq, "status", raw, attributes={"event_type": typ})

