import json

import pytest

from harnessblog.adapters import adapter_for


@pytest.mark.parametrize(
    ("name", "payload", "kind"),
    [
        ("pi", {"type": "assistant_message", "message": {"role": "assistant", "content": "done"}}, "assistant_msg"),
        ("cline", {"type": "say", "say": "text", "text": "done"}, "assistant_msg"),
        ("claude", {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"x": 1}, "id": "t1"}]}}, "tool_use"),
        ("codex", {"type": "item.completed", "item": {"type": "agent_message", "text": "done"}}, "assistant_msg"),
    ],
)
def test_json_adapters(name, payload, kind):
    events = adapter_for(name).parse([json.dumps(payload), "not-json"])
    assert len(events) == 1
    assert events[0].kind == kind


def test_hermes_plain_output():
    events = adapter_for("hermes").parse(["done"])
    assert events[0].kind == "assistant_msg"

