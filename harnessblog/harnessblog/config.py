from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from .models import RunSpec

HARNESSES = ("pi", "cline", "hermes", "claude", "codex", "ouroboros")
MODELS = ("openai/gpt-5.6-sol", "moonshotai/kimi-k3")
TASKS = ("three-body", "heat-2d")
VERSIONS = {
    "pi": "0.84.1",
    "cline": "3.0.53",
    "hermes": "v2026.8.3",
    "claude": "2.1.228",
    "codex": "0.147.0",
    "ouroboros": "6.100.0",
}


@dataclass(frozen=True)
class CampaignConfig:
    campaign_id: str
    budget_usd: float = 100.0
    per_run_budget_usd: float = 4.5
    reserve_usd: float = 10.0
    timeout_seconds: int = 3600
    seed: int = 20260812
    harness: str | None = None


def load_prompt(root: Path, task: str) -> str:
    return (root / "tasks" / task / "prompt.md").read_text(encoding="utf-8")


def build_specs(root: Path, cfg: CampaignConfig) -> list[RunSpec]:
    specs: list[RunSpec] = []
    for task in TASKS:
        prompt_hash = hashlib.sha256(load_prompt(root, task).encode()).hexdigest()
        for harness in HARNESSES:
            if cfg.harness and harness != cfg.harness:
                continue
            for model in MODELS:
                short_model = model.split("/")[-1]
                run_id = f"{task}--{harness}--{short_model}--r1"
                specs.append(RunSpec(
                    campaign_id=cfg.campaign_id,
                    run_id=run_id,
                    task=task,
                    harness=harness,
                    model=model,
                    seed=cfg.seed,
                    image=f"harnessblog/{harness}:{VERSIONS[harness]}",
                    prompt_hash=prompt_hash,
                    timeout_seconds=cfg.timeout_seconds,
                    budget_usd=cfg.per_run_budget_usd,
                ))
    return specs


def config_json(cfg: CampaignConfig) -> str:
    return json.dumps(cfg.__dict__, sort_keys=True)
