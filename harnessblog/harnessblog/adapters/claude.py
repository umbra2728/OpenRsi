from __future__ import annotations

from typing import Any

from .base import JsonAdapter
from ..models import RunSpec, TraceEvent


class ClaudeAdapter(JsonAdapter):
    name = "claude"

    def command(self, spec: RunSpec, prompt_path: str = "/run/prompt.md") -> list[str]:
        return ["sh", "-lc", f'exec claude --verbose --print --output-format stream-json --include-partial-messages --include-hook-events --permission-mode bypassPermissions --model {spec.model} "$(cat {prompt_path})"']

    def convert(self, seq: int, raw: dict[str, Any]) -> TraceEvent | None:
        typ = str(raw.get("type", ""))
        message = raw.get("message", {})
        content = message.get("content", []) if isinstance(message, dict) else []
        block = content[-1] if isinstance(content, list) and content else {}
        block_type = block.get("type") if isinstance(block, dict) else ""
        if block_type == "thinking":
            return self.event(seq, "thinking", raw, text=str(block.get("thinking", "")))
        if block_type == "tool_use":
            return self.event(seq, "tool_use", raw, tool=str(block.get("name", "unknown")), tool_input=block.get("input"), parent_tool_id=block.get("id"))
        if block_type == "tool_result":
            return self.event(seq, "tool_result", raw, text=str(block.get("content", "")), parent_tool_id=block.get("tool_use_id"))
        text = raw.get("result") or (block.get("text") if isinstance(block, dict) else None)
        if typ in {"assistant", "result", "stream_event"} and text:
            return self.event(seq, "assistant_msg", raw, text=str(text))
        return self.event(seq, "status", raw, attributes={"event_type": typ})
