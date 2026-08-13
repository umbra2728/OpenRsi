from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from .models import RunSpec


@dataclass
class ProcessOutput:
    exit_code: int
    stdout: str
    stderr: str
    gpu: dict[str, object]


def docker_command(spec: RunSpec, run_dir: Path, adapter_command: list[str]) -> list[str]:
    workspace = run_dir / "workspace"
    home = run_dir / "home"
    workspace.mkdir(parents=True, exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    proxy = os.getenv("OPENROUTER_PROXY_URL")
    if spec.harness == "pi" and proxy:
        pi_dir = home / ".pi" / "agent"
        pi_dir.mkdir(parents=True, exist_ok=True)
        (pi_dir / "models.json").write_text(json.dumps({
            "providers": {"openrouter": {
                "baseUrl": f"{proxy}/v1",
                "apiKey": "$OPENROUTER_API_KEY",
            }}
        }), encoding="utf-8")
    cmd = [
        "docker", "run", "--rm", "--init", "--gpus", "device=0", "--network", "host",
        "--cpus", "16", "--memory", "64g", "--pids-limit", "4096",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", f"{os.getuid()}:{os.getgid()}", "--workdir", "/workspace",
        "-e", "HOME=/home/agent", "-e", f"OPENROUTER_API_KEY={os.environ.get('RUN_PROXY_TOKEN', 'run-scoped-token')}",
        "-e", f"OPENAI_API_KEY={os.environ.get('RUN_PROXY_TOKEN', 'run-scoped-token')}",
        "-e", "ANTHROPIC_API_KEY=", "-e", f"ANTHROPIC_AUTH_TOKEN={os.environ.get('RUN_PROXY_TOKEN', 'run-scoped-token')}",
        "-e", f"ANTHROPIC_DEFAULT_OPUS_MODEL={spec.model}",
        "-e", f"ANTHROPIC_DEFAULT_SONNET_MODEL={spec.model}",
        "-e", f"ANTHROPIC_DEFAULT_HAIKU_MODEL={spec.model}",
        "-e", f"CLAUDE_CODE_SUBAGENT_MODEL={spec.model}",
        "-v", f"{workspace.resolve()}:/workspace:rw",
        "-v", f"{home.resolve()}:/home/agent:rw",
        "-v", f"{(run_dir / 'prompt.md').resolve()}:/run/prompt.md:ro",
        spec.image,
        *adapter_command,
    ]
    if proxy:
        # Adapter-specific skins are configured by the image entrypoint from this common base.
        insert = cmd.index(spec.image)
        cmd[insert:insert] = [
            "-e", f"OPENAI_BASE_URL={proxy}/v1",
            "-e", f"OPENROUTER_BASE_URL={proxy}/v1",
            "-e", f"ANTHROPIC_BASE_URL={proxy}",
        ]
    return cmd


def execute(cmd: list[str], timeout: int) -> ProcessOutput:
    query = ["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"]
    def sample() -> set[str]:
        result = subprocess.run(query, text=True, capture_output=True, check=False)
        return {line.strip() for line in result.stdout.splitlines() if line.strip()}
    baseline = sample()
    observed: set[str] = set()
    peak_memory = 0
    with tempfile.TemporaryFile(mode="w+") as stdout, tempfile.TemporaryFile(mode="w+") as stderr:
        proc = subprocess.Popen(cmd, text=True, stdout=stdout, stderr=stderr)
        deadline = time.monotonic() + timeout
        exit_code = 124
        while proc.poll() is None:
            current = sample()
            new = current - baseline
            observed.update(new)
            for row in new:
                try: peak_memory = max(peak_memory, int(row.rsplit(",", 1)[1].strip()))
                except (ValueError, IndexError): pass
            if time.monotonic() >= deadline:
                proc.kill()
                stderr.write("\ntimeout\n")
                break
            time.sleep(0.5)
        else:
            exit_code = int(proc.returncode)
        proc.wait()
        stdout.seek(0); stderr.seek(0)
        return ProcessOutput(exit_code, stdout.read(), stderr.read(), {
            "baseline_processes": sorted(baseline),
            "new_processes": sorted(observed),
            "cuda_process_verified": bool(observed),
            "peak_new_process_memory_mib": peak_memory,
        })
