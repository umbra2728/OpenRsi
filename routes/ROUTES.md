# Route pinning for the paper-shaped OpenRouter grid

Seed and candidates must be measured on the **same, fixed** inference route, and
no historical baseline may be reused after a provider/route change. This folder
holds the tooling to make that true and auditable.

## Why overlays (not editing canonical YAML)

The canonical `build.yaml` files under `vero/harness-engineering-bench/<task>/baseline/`
are read-only truth. We never edit them. A *route overlay* is a generated,
standalone `build.<route>.yaml` written **into the same `baseline/` directory**
(so its relative paths — `agent_repo`, `partition_files`, `task_manifest` — still
resolve). It differs from the canonical only in:

- `inference_gateway.*.model_aliases` — pins the exact upstream OpenRouter slug
  per scope, **after** the allow-list check, so the caller-visible model (the
  cell label and the candidate's request) is unchanged but the served deployment
  is fixed;
- baseline handling — unless a measured K=3 value is supplied, `baseline_reward`
  is dropped and `score_baseline: true`, so the seed is re-measured on THIS route
  instead of inheriting a wrong pin;
- `wandb.name`/`tags` — a route suffix so an overlay run can never be confused
  with a canonical run.

## Same route for seed and candidates (already structural)

Within one `vero harbor run`, the target agent (candidate) and the trusted
finalization/seed scoring both go through the **same** gateway → same
`OPENAI_BASE_URL` (OpenRouter) → same model slug / alias. The seed re-pin uses
`vero/harness-engineering-bench/scripts/rescore_candidate.py --seed` sourced from
the **same** `secrets.env`. So "same route" is guaranteed by construction; the
overlay only adds the provider pin and honest baseline handling.

## Provider pin: the one thing that needs a live check

`model_aliases` fixes the *slug*, but a bare OpenRouter slug can still
load-balance across providers. To pin the actual provider/deployment:

1. Run `routes/probe_route.py` at **Stage 1** (small paid spend, NOT free) to see
   which provider serves each slug and whether `provider.only` +
   `allow_fallbacks:false` is honored.
2. Put a single-provider slug into each `*.route.json` `aliases` map.
3. If a single-provider slug is unavailable, label results **OpenRouter-routed**
   (not provider-pinned) and keep a contemporaneous seed control in every block.

Until then the shipped `*.route.json` use **identity aliases** — a safe default
that produces a route-labelled copy with the seed re-measured, and prints a
warning that the provider is not yet pinned.

## Files

- `make_route_overlay.py` — generate an overlay from a canonical build + a route JSON.
- `probe_route.py` — Stage-1 provider probe (paid; do not run in Stage 0).
- `<task>.route.json` — per-task alias map + baseline mode + label.

Route templates:

| Route file | Canonical build | Target model (caller) | Notes |
| --- | --- | --- | --- |
| `terminal-bench.route.json` | `terminal-bench/baseline/build.yaml` | `xai/grok-build-0.1` | first confirmatory task; deterministic verifier |
| `officeqa.route.json` | `officeqa/baseline/build.yaml` | `fireworks_ai/deepseek-v4-flash` | vendor task data + manifest first |
| `browsecomp-plus.route.json` | `browsecomp-plus/baseline/build.yaml` | `fireworks_ai/deepseek-v4-flash` | keep gpt-4.1 judge upstream; resolve split provenance |
| `gaia-shell.route.json` | `gaia/baseline/build.shell.yaml` | `gpt-5.4-mini` | exploratory; stateless candidates only |

## Generate an overlay (on eva01, into the vero baseline dir)

```bash
HEB=/mnt/storage/harnessopt/vero/harness-engineering-bench
cd /mnt/storage/harnessopt/openrsi
/mnt/storage/bin/uv run python routes/make_route_overlay.py \
  --config "$HEB/terminal-bench/baseline/build.yaml" \
  --route  routes/terminal-bench.route.json \
  --output "$HEB/terminal-bench/baseline/build.openrouter.yaml" --force
```

The overlay and its `*.route.json` manifest (source hash, overlay hash, applied
aliases, baseline mode) are written next to the canonical file. The overlay is an
ephemeral artifact — regenerate it per run; do not commit it into the vero repo.

## Launch with the overlay

```bash
# GAIA shell (exploratory):
OPENRSI_BUILD_VARIANT=shell scripts/run_harnessopt.sh gaia openai/gpt-5.6-sol
# Any task with an explicit overlay:
OPENRSI_BUILD_CONFIG=terminal-bench/baseline/build.openrouter.yaml \
  scripts/run_harnessopt.sh terminal-bench openai/gpt-5.6-sol
```

Both print the resolved build path + SHA-256 and archive it in `launch.env`, so
every run records exactly which route config produced its numbers.
