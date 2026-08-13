# harnessblog

Reproducible CUDA coding-agent benchmark for Pi, Cline, Hermes Agent, Claude Code, and Codex, with GPT-5.6 Sol and Kimi K3 through OpenRouter. Events, scores, images, and videos are spooled locally and uploaded to Tracehouse.

## Safety first

Never reuse credentials pasted into chat or committed to a repository. Revoke them, create a dedicated OpenRouter inference key with a lifetime `$100` limit, and create a new Tracehouse key. Export them only on the runner host:

```bash
# Run these inside an interactive shell on eva02, never in shell history.
read -rsp 'OpenRouter key: ' OPENROUTER_API_KEY; export OPENROUTER_API_KEY; echo
read -rsp 'Tracehouse key: ' TRACEHOUSE_API_KEY; export TRACEHOUSE_API_KEY; echo
export TRACEHOUSE_API_BASE='https://tracehouse.ai'
```

The runner starts a private host-side gateway automatically, generates a random run token, and keeps the real OpenRouter key out of agent containers. `OPENROUTER_PROXY_URL` and `RUN_PROXY_TOKEN` may instead select an externally managed gateway.

## Setup and run

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
harnessblog preflight --host eva02
harnessblog build-images --host eva02
ssh -t eva02
# The sync directory suffix is the UID of the machine where harnessblog was invoked.
cd /tmp/harnessblog-501
python3 -m harnessblog.cli run --budget-usd 100
```

Replace `501` with the local UID printed by `id -u`. Keeping the paid command in
that interactive remote shell ensures neither API key is forwarded in an SSH
argument or stored by this project.

Dry-run the complete 20-run manifest without model calls:

```bash
harnessblog run --campaign-id smoke --dry-run
harnessblog report smoke
```

Campaign state and the idempotent trace spool live under `.harnessblog/campaigns/<id>/`. Re-run with `harnessblog resume <id>` after a failure.

## Benchmark policy

- One measured run for each task × harness × model combination.
- Native harness defaults; identical English task prompts and resource limits.
- Sequential runs on GPU 0, 16 CPUs, 64 GB RAM, one hour, and a `$4.50` soft run allocation.
- Correctness is scored; timing and GPU utilization are diagnostic because `eva02` is shared.
- A score requires independent evaluator evidence. Self-reported model text is never a pass condition.
