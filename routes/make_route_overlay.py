#!/usr/bin/env python3
"""Generate an immutable, route-pinned overlay of a canonical HarnessOpt build.yaml.

We never edit the canonical benchmark YAML in place. Instead this emits a
standalone overlay that:

  1. pins the exact upstream OpenRouter slug for every inference scope via
     ``model_aliases`` (caller-visible ``allowed_models`` stay unchanged, so the
     cell label and the candidate's request are untouched -- only the deployment
     that serves it is fixed);
  2. refuses to carry a stale baseline: unless an explicitly measured
     route-specific ``--baseline`` is provided, it drops ``baseline_reward`` and
     sets ``score_baseline: true`` so the seed is re-measured on THIS route (a
     wrong pin is worse than an extra held-out pass);
  3. labels the run so a route overlay can never be confused with a canonical
     run in W&B or results/.

The generated overlay loses YAML comments (it is a machine artifact); the
canonical file is read-only and stays authoritative. A companion
``<overlay>.route.json`` records the alias map, baseline mode, source hash, and
overlay hash for the run manifest.

Usage:
  uv run python routes/make_route_overlay.py \
      --config ../vero/harness-engineering-bench/terminal-bench/baseline/build.yaml \
      --route  routes/terminal-bench.route.json \
      --output ../vero/harness-engineering-bench/terminal-bench/baseline/build.openrouter.yaml

A route file is JSON like:
  {
    "route": "openrouter",
    "aliases": {                         # caller model -> exact upstream slug
      "gpt-5.4-mini": "openai/gpt-4o-mini",
      "openai/gpt-5.6-sol": "openai/gpt-5.6-sol"
    },
    "baseline_reward": null,             # or a measured K=3 float once repinned
    "wandb_suffix": "openrouter"
  }

Identity aliases are allowed (and are the safe default before a live catalog
probe): the overlay is then a route-labelled copy with the baseline re-measured.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is required. Run through the vero env: `uv run python ...`.")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def apply_aliases(scope: dict[str, Any], aliases: dict[str, str]) -> dict[str, str]:
    """Set model_aliases on one gateway scope for whatever models it allows.

    Only maps models this scope actually lists in allowed_models, so a producer
    scope pins the optimizer model and an evaluation/finalization scope pins the
    target model, without cross-contamination. Self-aliases (identity) are kept
    verbatim -- the gateway drops them, and keeping them documents intent.
    """
    allowed = scope.get("allowed_models") or []
    applied: dict[str, str] = {}
    for model in allowed:
        # allowed_models entries may contain a ${optimizer_model:-...} template;
        # map both the raw entry and its default when present.
        candidates = {model}
        if isinstance(model, str) and model.startswith("${") and ":-" in model:
            candidates.add(model.split(":-", 1)[1].rstrip("}"))
        for name in candidates:
            if name in aliases:
                applied[name] = aliases[name]
    if applied:
        existing = scope.get("model_aliases") or {}
        existing.update(applied)
        scope["model_aliases"] = existing
    return applied


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True, type=Path, help="canonical build.yaml (read-only)")
    ap.add_argument("--route", required=True, type=Path, help="route JSON (aliases, baseline, label)")
    ap.add_argument("--output", required=True, type=Path, help="overlay build.yaml to write")
    ap.add_argument("--force", action="store_true", help="overwrite an existing overlay")
    args = ap.parse_args()

    if not args.config.is_file():
        return _fail(f"canonical config not found: {args.config}")
    if not args.route.is_file():
        return _fail(f"route file not found: {args.route}")
    if args.output.exists() and not args.force:
        return _fail(f"overlay already exists (use --force): {args.output}")

    try:
        route = json.loads(args.route.read_text())
    except (OSError, json.JSONDecodeError) as err:
        return _fail(f"could not read route JSON {args.route}: {err}")
    if not isinstance(route, dict):
        return _fail("route file did not parse as a JSON object")
    aliases: dict[str, str] = route.get("aliases") or {}
    baseline_raw = route.get("baseline_reward", None)  # None => re-measure on this route
    baseline: float | None
    if baseline_raw is None:
        baseline = None
    else:
        try:
            baseline = float(baseline_raw)
        except (TypeError, ValueError):
            return _fail(f"baseline_reward must be a number or null, got {baseline_raw!r}")
    suffix = route.get("wandb_suffix") or route.get("route") or "route"

    doc = yaml.safe_load(args.config.read_text())
    if not isinstance(doc, dict):
        return _fail("canonical config did not parse as a mapping")

    # 1) pin upstream deployment per scope
    applied_by_scope: dict[str, dict[str, str]] = {}
    gw = doc.get("inference_gateway") or {}
    for scope_name in ("producer", "evaluation", "finalization"):
        scope = gw.get(scope_name)
        if isinstance(scope, dict):
            applied_by_scope[scope_name] = apply_aliases(scope, aliases)

    # 2) baseline handling: honest by default
    baseline_mode: str
    for target in doc.get("targets", []) or []:
        if not isinstance(target, dict):
            continue
        if baseline is None:
            target.pop("baseline_reward", None)
        else:
            target["baseline_reward"] = baseline
    if baseline is None:
        doc["score_baseline"] = True  # re-measure the seed on THIS route
        baseline_mode = "re-measure (score_baseline=true, no pin)"
    else:
        doc["score_baseline"] = False
        baseline_mode = f"pinned={baseline} (score_baseline=false)"

    # 3) route label so overlays never collide with canonical runs
    wandb = doc.get("wandb")
    if isinstance(wandb, dict):
        name = wandb.get("name")
        if isinstance(name, str) and suffix not in name:
            wandb["name"] = f"{name}-{suffix}"
        tags = wandb.get("tags")
        if isinstance(tags, list) and suffix not in tags:
            tags.append(suffix)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    header = (
        f"# GENERATED route overlay -- DO NOT EDIT BY HAND.\n"
        f"# source: {args.config}\n"
        f"# source_sha256: {sha256(args.config)}\n"
        f"# route: {args.route.name} ({suffix})\n"
        f"# baseline: {baseline_mode}\n"
        f"# regenerate: routes/make_route_overlay.py --config {args.config} "
        f"--route {args.route} --output {args.output} --force\n"
    )
    body = yaml.safe_dump(doc, sort_keys=False, width=100)
    args.output.write_text(header + body)

    manifest = {
        "source": str(args.config),
        "source_sha256": sha256(args.config),
        "overlay": str(args.output),
        "overlay_sha256": sha256(args.output),
        "route": route,
        "applied_aliases": applied_by_scope,
        "baseline_mode": baseline_mode,
    }
    manifest_path = args.output.with_suffix(args.output.suffix + ".route.json")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    print(f"wrote overlay: {args.output}")
    print(f"wrote manifest: {manifest_path}")
    for scope_name, applied in applied_by_scope.items():
        pins = ", ".join(f"{k}->{v}" for k, v in applied.items()) or "(none)"
        print(f"  {scope_name}: {pins}")
    print(f"  baseline: {baseline_mode}")
    if not aliases or all(k == v for k, v in aliases.items()):
        print("  NOTE: identity/empty aliases -- provider is NOT pinned yet. Fill exact")
        print("        single-provider OpenRouter slugs after routes/probe_route.py (Stage 1).")
    return 0


def _fail(msg: str) -> int:
    print(f"error: {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
