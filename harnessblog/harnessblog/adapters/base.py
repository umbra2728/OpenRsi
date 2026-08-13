from __future__ import annotations

import json
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any, Iterable

from ..models import RunSpec, TraceEvent
from ..security import redact


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_lines(lines: Iterable[str]) -> Iterable[dict[str, Any]]:
    for line in lines:
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                yield value
        except (json.JSONDecodeError, TypeError):
            continue


class Adapter(ABC):
    name: str

    @abstractmethod
    def command(self, spec: RunSpec, prompt_path: str = "/run/prompt.md") -> list[str]: ...

    @abstractmethod
    def parse(self, lines: Iterable[str]) -> list[TraceEvent]: ...

    def event(self, seq: int, kind: str, raw: dict[str, Any], **kwargs: Any) -> TraceEvent:
        return TraceEvent(
            sequence=seq,
            timestamp=str(raw.get("timestamp") or raw.get("ts") or _now()),
            kind=kind,  # type: ignore[arg-type]
            raw=redact(raw),
            **redact(kwargs),
        )


class JsonAdapter(Adapter):
    def parse(self, lines: Iterable[str]) -> list[TraceEvent]:
        result: list[TraceEvent] = []
        for raw in _json_lines(lines):
            event = self.convert(len(result), raw)
            if event:
                result.append(event)
        return result

    @abstractmethod
    def convert(self, seq: int, raw: dict[str, Any]) -> TraceEvent | None: ...


def adapter_for(name: str) -> Adapter:
    from .claude import ClaudeAdapter
    from .cline import ClineAdapter
    from .codex import CodexAdapter
    from .hermes import HermesAdapter
    from .pi import PiAdapter
    from .ouroboros import OuroborosAdapter

    adapters = {a.name: a for a in (PiAdapter(), ClineAdapter(), HermesAdapter(), ClaudeAdapter(), CodexAdapter(), OuroborosAdapter())}
    try:
        return adapters[name]
    except KeyError as exc:
        raise ValueError(f"unknown harness: {name}") from exc
