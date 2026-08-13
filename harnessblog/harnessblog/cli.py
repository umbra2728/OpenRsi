from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from .config import CampaignConfig
from .orchestrator import Campaign, sync_and_run_remote
from .preflight import print_checks, run_preflight
from .report import render


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="harnessblog")
    p.add_argument("--root", type=Path, default=Path.cwd())
    sub = p.add_subparsers(dest="command", required=True)
    pre = sub.add_parser("preflight")
    pre.add_argument("--host", default="eva02")
    run = sub.add_parser("run")
    run.add_argument("--campaign-id")
    run.add_argument("--budget-usd", type=float, default=100)
    run.add_argument("--per-run-budget-usd", type=float, default=4.5)
    run.add_argument("--reserve-usd", type=float, default=10)
    run.add_argument("--timeout", type=int, default=3600)
    run.add_argument("--dry-run", action="store_true")
    run.add_argument("--host")
    run.add_argument("--harness", choices=("pi", "cline", "hermes", "claude", "codex", "ouroboros"))
    resume = sub.add_parser("resume")
    resume.add_argument("campaign_id")
    resume.add_argument("--dry-run", action="store_true")
    report = sub.add_parser("report")
    report.add_argument("campaign_id")
    build = sub.add_parser("build-images")
    build.add_argument("--host")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    root = args.root.resolve()
    if args.command == "preflight":
        checks = run_preflight(args.host)
        print_checks(checks)
        return 0 if all(c.ok for c in checks if c.name not in {"openrouter_api_key", "tracehouse_api_key"}) else 1
    if args.command == "build-images":
        command = ["bash", "scripts/build-images.sh"]
        return sync_and_run_remote(root, args.host, command) if args.host else os.spawnvp(os.P_WAIT, command[0], command)
    if args.command == "report":
        state = root / ".harnessblog" / "campaigns" / args.campaign_id / "state.json"
        text = render(state)
        output = state.parent / "report.md"
        output.write_text(text)
        print(text, end="")
        return 0
    campaign_id = getattr(args, "campaign_id", None) or datetime.now(timezone.utc).strftime("cuda-%Y%m%dT%H%M%SZ")
    if args.command == "resume":
        state_path = root / ".harnessblog" / "campaigns" / campaign_id / "state.json"
        if not state_path.exists():
            print(f"unknown campaign: {campaign_id}", file=sys.stderr)
            return 2
        cfg = CampaignConfig(campaign_id)
    else:
        cfg = CampaignConfig(campaign_id, args.budget_usd, args.per_run_budget_usd, args.reserve_usd, args.timeout, harness=args.harness)
        if args.host:
            remote_args = ["python3", "-m", "harnessblog.cli", "run", "--campaign-id", campaign_id, "--budget-usd", str(args.budget_usd), "--per-run-budget-usd", str(args.per_run_budget_usd), "--reserve-usd", str(args.reserve_usd), "--timeout", str(args.timeout)]
            if args.dry_run: remote_args.append("--dry-run")
            return sync_and_run_remote(root, args.host, remote_args)
    state = Campaign(root, cfg, dry_run=args.dry_run).run()
    print(json.dumps(state, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
