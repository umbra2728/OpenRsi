from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Iterable

from .base import Adapter
from ..models import RunSpec, TraceEvent
from ..security import redact_text


class HermesAdapter(Adapter):
    name = "hermes"

    def command(self, spec: RunSpec, prompt_path: str = "/run/prompt.md") -> list[str]:
        return ["sh", "-lc", f'exec hermes chat --quiet --yolo --ignore-user-config --ignore-rules --provider openrouter --model {spec.model} -q "$(cat {prompt_path})"']

    def parse(self, lines: Iterable[str]) -> list[TraceEvent]:
        events: list[TraceEvent] = []
        for line in lines:
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                if line.strip():
                    events.append(TraceEvent(len(events), datetime.now(timezone.utc).isoformat(), "assistant_msg", text=redact_text(line.rstrip())))
                continue
            role = raw.get("role") or raw.get("from")
            kind = "assistant_msg" if role == "assistant" else "status"
            events.append(self.event(len(events), kind, raw, text=str(raw.get("content") or raw.get("text") or "")))
        return events

