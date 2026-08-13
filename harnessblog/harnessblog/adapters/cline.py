from __future__ import annotations

from typing import Any

from .base import JsonAdapter
from ..models import RunSpec, TraceEvent


class ClineAdapter(JsonAdapter):
    name = "cline"

    def command(self, spec: RunSpec, prompt_path: str = "/run/prompt.md") -> list[str]:
        return ["sh", "-lc", f'cline auth --provider openai-compatible --apikey "$OPENAI_API_KEY" --baseurl "$OPENAI_BASE_URL" --modelid {spec.model} --config /home/agent/.cline --data-dir /home/agent/.cline/data >/dev/null && exec cline --json --auto-approve true --provider openai-compatible --model {spec.model} --cwd /workspace --config /home/agent/.cline --data-dir /home/agent/.cline/data "$(cat {prompt_path})"']

    def convert(self, seq: int, raw: dict[str, Any]) -> TraceEvent | None:
        typ = str(raw.get("type", ""))
        subtype = str(raw.get("say") or raw.get("ask") or raw.get("event", {}).get("type", ""))
        text = raw.get("text") or raw.get("reasoning")
        if raw.get("reasoning") or "reason" in subtype:
            return self.event(seq, "thinking", raw, text=str(text or ""))
        if "tool" in subtype:
            kind = "tool_result" if any(x in subtype for x in ("result", "end", "finished")) else "tool_use"
            return self.event(seq, kind, raw, tool=str(raw.get("tool") or subtype), tool_input=raw.get("input"))
        if typ in {"say", "chunk"} and text:
            return self.event(seq, "assistant_msg", raw, text=str(text))
        return self.event(seq, "status", raw, attributes={"event_type": typ, "subtype": subtype})
