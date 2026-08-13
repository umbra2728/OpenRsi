from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .io import append_jsonl
from .models import RunResult, RunSpec, TraceEvent
from .security import redact


class TraceSink:
    """Idempotent local spool plus best-effort Tracehouse uploader."""

    def __init__(self, spool: Path, project: str = "harnessblog", enabled: bool = True):
        self.spool = spool
        self.project = project
        self.enabled = enabled and bool(os.getenv("TRACEHOUSE_API_KEY"))
        self._run: Any = None

    def start(self, spec: RunSpec) -> None:
        self.spool.mkdir(parents=True, exist_ok=True)
        append_jsonl(self.spool / "trace.jsonl", {"record": "spec", "value": spec.to_dict()})
        if self.enabled:
            try:
                import tracehouse as cm
                self._run = cm.Run(
                    project=self.project,
                    session_id=spec.run_id,
                    task_name=spec.task,
                    model=spec.model,
                    scaffold=spec.harness,
                )
            except Exception:
                self._run = None

    def event(self, event: TraceEvent) -> None:
        data = redact(event.to_dict())
        append_jsonl(self.spool / "trace.jsonl", {"record": "event", "value": data})
        if not self._run:
            return
        # Raw token/status events remain losslessly in trace.jsonl. Uploading
        # each streaming delta as an attachment creates thousands of network
        # requests and can outlive the actual agent run.
        try:
            if event.kind == "user_msg": self._run.log_user(event.text or "")
            elif event.kind == "assistant_msg": self._run.log_assistant(event.text or "")
            elif event.kind == "thinking": self._run.log_thinking(event.text or "")
            elif event.kind == "tool_use": self._run.log_tool_use(event.tool or "unknown", event.tool_input or {})
            elif event.kind == "tool_result": self._run.log_tool_result(event.text or json.dumps(event.raw or {}), parent_span_id=event.parent_tool_id)
        except Exception:
            pass

    def finish(self, result: RunResult) -> None:
        append_jsonl(self.spool / "trace.jsonl", {"record": "result", "value": redact(result.to_dict())})
        if self._run:
            try:
                self._run.finish(
                    outcome="good" if result.passed else "bad",
                    metadata=redact(result.to_dict()),
                    task_name=result.run_id,
                )
            except Exception:
                pass

    def media(self, output_dir: Path) -> None:
        if not output_dir.exists():
            return
        for path in output_dir.iterdir():
            if not path.is_file() or path.stat().st_size > 25 * 1024 * 1024:
                continue
            try:
                if self._run and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
                    self._run.log_image(path.stem, str(path), caption=path.name)
                elif self._run and path.suffix.lower() in {".mp4", ".webm", ".mov"}:
                    self._run.log_video(path.stem, str(path))
            except Exception:
                pass
