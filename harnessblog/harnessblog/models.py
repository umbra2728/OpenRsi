from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

EventKind = Literal[
    "user_msg", "assistant_msg", "thinking", "tool_use", "tool_result", "status", "attachment"
]


@dataclass(frozen=True)
class RunSpec:
    campaign_id: str
    run_id: str
    task: str
    harness: str
    model: str
    seed: int
    image: str
    prompt_hash: str
    timeout_seconds: int = 3600
    budget_usd: float = 4.5

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TraceEvent:
    sequence: int
    timestamp: str
    kind: EventKind
    text: str | None = None
    tool: str | None = None
    tool_input: dict[str, Any] | None = None
    parent_tool_id: str | None = None
    attributes: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RunResult:
    run_id: str
    status: str
    exit_code: int | None
    score: float = 0.0
    passed: bool = False
    hard_gates: dict[str, bool] = field(default_factory=dict)
    usage: dict[str, float] = field(default_factory=dict)
    metrics: dict[str, float | str | bool] = field(default_factory=dict)
    artifacts: dict[str, str] = field(default_factory=dict)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Paths:
    root: Path

    @property
    def state(self) -> Path:
        return self.root / ".harnessblog"

    def campaign(self, campaign_id: str) -> Path:
        return self.state / "campaigns" / campaign_id

    def run(self, campaign_id: str, run_id: str) -> Path:
        return self.campaign(campaign_id) / "runs" / run_id

