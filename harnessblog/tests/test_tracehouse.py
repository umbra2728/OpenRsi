import json

from harnessblog.models import RunResult, RunSpec, TraceEvent
from harnessblog.tracehouse import TraceSink


def test_spool_is_redacted(tmp_path):
    sink = TraceSink(tmp_path, enabled=False)
    spec = RunSpec("c", "r", "t", "pi", "m", 1, "i", "h")
    sink.start(spec)
    sink.event(TraceEvent(0, "now", "assistant_msg", text="sk-or-v1-abcdefghijklmnopqrstuvwxyz123456"))
    sink.finish(RunResult("r", "finished", 0))
    text = (tmp_path / "trace.jsonl").read_text()
    assert "abcdefghijklmnopqrstuvwxyz" not in text
    assert "[REDACTED]" in text

