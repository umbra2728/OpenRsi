from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from .adapters import adapter_for
from .budget import BudgetExhausted, BudgetLedger
from .config import CampaignConfig, build_specs, load_prompt
from .docker import docker_command, execute
from .evaluate import evaluate
from .io import atomic_json
from .models import Paths, RunResult, TraceEvent
from .proxy import OpenRouterProxy
from .security import redact_text
from .tracehouse import TraceSink


class Campaign:
    def __init__(self, root: Path, config: CampaignConfig, dry_run: bool = False):
        self.root = root
        self.paths = Paths(root)
        self.config = config
        self.dry_run = dry_run
        self.dir = self.paths.campaign(config.campaign_id)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.state_file = self.dir / "state.json"
        self.state = self._load_state()
        spent = sum(float(v.get("usage", {}).get("cost_usd", 0)) for v in self.state["results"].values())
        self.ledger = BudgetLedger(config.budget_usd, config.reserve_usd, spent)

    def _load_state(self) -> dict:
        if self.state_file.exists():
            return json.loads(self.state_file.read_text())
        return {"campaign_id": self.config.campaign_id, "created_at": datetime.now(timezone.utc).isoformat(), "results": {}}

    def _save(self) -> None:
        atomic_json(self.state_file, self.state)

    def run(self) -> dict:
        proxy: OpenRouterProxy | None = None
        prior_proxy = os.environ.get("OPENROUTER_PROXY_URL")
        prior_token = os.environ.get("RUN_PROXY_TOKEN")
        if not self.dry_run and not prior_proxy:
            key = os.environ.get("OPENROUTER_API_KEY")
            if not key:
                raise RuntimeError("OPENROUTER_API_KEY is required for paid runs")
            proxy = OpenRouterProxy(key, self.config.budget_usd)
            proxy.start()
            # eva02 blocks traffic from the Docker bridge to host ports. Host
            # networking keeps the gateway loopback-only and avoids opening it
            # on the LAN; filesystem/PID/resource isolation remains intact.
            os.environ["OPENROUTER_PROXY_URL"] = f"http://127.0.0.1:{proxy.port}"
            os.environ["RUN_PROXY_TOKEN"] = proxy.state.client_token
        specs = build_specs(self.root, self.config)
        if not self.dry_run:
            resolved = []
            for spec in specs:
                inspect = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}}", spec.image], text=True, capture_output=True, check=False)
                resolved.append(replace(spec, image=inspect.stdout.strip() or spec.image))
            specs = resolved
        atomic_json(self.dir / "manifest.json", [s.to_dict() for s in specs])
        try:
            for spec in specs:
                previous = self.state["results"].get(spec.run_id)
                if previous and previous.get("status") in {"finished", "incompatible", "budget_exhausted"}:
                    continue
                try:
                    self.ledger.admit(spec.budget_usd)
                except BudgetExhausted as exc:
                    result = RunResult(spec.run_id, "budget_exhausted", None, error=str(exc))
                    self.state["results"][spec.run_id] = result.to_dict()
                    self._save()
                    break
                before = proxy.state.spent_usd if proxy else 0.0
                before_requests = proxy.state.requests if proxy else 0
                if proxy: proxy.begin_run(spec.budget_usd)
                result = self._run_one(spec)
                if proxy:
                    result.usage["cost_usd"] = max(0.0, proxy.state.spent_usd - before)
                    result.usage["proxy_requests"] = proxy.state.requests - before_requests
                self.state["results"][spec.run_id] = result.to_dict()
                self.ledger.charge(float(result.usage.get("cost_usd", 0)))
                self._save()
        finally:
            if proxy:
                proxy.stop()
                if prior_proxy is None: os.environ.pop("OPENROUTER_PROXY_URL", None)
                if prior_token is None: os.environ.pop("RUN_PROXY_TOKEN", None)
        return self.state

    def _run_one(self, spec) -> RunResult:
        run_dir = self.paths.run(spec.campaign_id, spec.run_id)
        run_dir.mkdir(parents=True, exist_ok=True)
        workspace = run_dir / "workspace"
        if workspace.exists():
            shutil.rmtree(workspace)
        workspace.mkdir(parents=True, exist_ok=True)
        prompt = load_prompt(self.root, spec.task)
        (run_dir / "prompt.md").write_text(prompt, encoding="utf-8")
        shutil.copy2(self.root / "tasks" / spec.task / "config.json", run_dir / "config.json")
        shutil.copy2(self.root / "tasks" / spec.task / "config.json", run_dir / "workspace" / "config.json")
        adapter = adapter_for(spec.harness)
        command = docker_command(spec, run_dir, adapter.command(spec))
        token = os.environ.get("RUN_PROXY_TOKEN", "")
        safe_command = [arg.replace(token, "[REDACTED]") if token else arg for arg in command]
        atomic_json(run_dir / "command.json", {"argv": safe_command[:-1] + ["[REDACTED-SHELL]"]})
        sink = TraceSink(run_dir / "spool", enabled=not self.dry_run)
        sink.start(spec)
        sink.event(TraceEvent(0, datetime.now(timezone.utc).isoformat(), "user_msg", text=prompt, attributes={"prompt_hash": spec.prompt_hash}))
        if self.dry_run:
            result = RunResult(spec.run_id, "dry_run", None)
            sink.finish(result)
            return result
        if not os.getenv("OPENROUTER_PROXY_URL") or not os.getenv("RUN_PROXY_TOKEN"):
            result = RunResult(spec.run_id, "failed", None, error="OPENROUTER_PROXY_URL and RUN_PROXY_TOKEN are required for secret-isolated paid runs")
            sink.finish(result)
            return result
        start = time.monotonic()
        output = execute(command, spec.timeout_seconds)
        duration = time.monotonic() - start
        (run_dir / "stdout.jsonl").write_text(redact_text(output.stdout), encoding="utf-8")
        (run_dir / "stderr.log").write_text(redact_text(output.stderr), encoding="utf-8")
        events = adapter.parse(output.stdout.splitlines())
        for event in events:
            event.sequence += 1
            sink.event(event)
        atomic_json(run_dir / "gpu.json", output.gpu)
        result = evaluate(spec.run_id, run_dir / "workspace", output.exit_code, output.gpu)
        result.metrics["wall_time_seconds"] = duration
        result.metrics["reasoning_visibility"] = any(e.kind == "thinking" for e in events)
        sink.media(run_dir / "workspace" / "output")
        sink.finish(result)
        return result


def sync_and_run_remote(root: Path, host: str, args: list[str]) -> int:
    remote = f"/tmp/harnessblog-{os.getuid()}"
    subprocess.run(["ssh", host, "mkdir", "-p", remote], check=True)
    subprocess.run(["rsync", "-az", "--delete", "--exclude", ".harnessblog", f"{root}/", f"{host}:{remote}/"], check=True)
    command = " ".join(subprocess.list2cmdline([arg]) for arg in args)
    return subprocess.run(["ssh", "-t", host, f"cd {remote} && {command}"], check=False).returncode
