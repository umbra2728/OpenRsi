import json
from pathlib import Path

from harnessblog.adapters import adapter_for
from harnessblog.docker import docker_command
from harnessblog.models import RunSpec


def spec(harness: str) -> RunSpec:
    return RunSpec(
        campaign_id="test",
        run_id=f"test-{harness}",
        harness=harness,
        model="openai/gpt-5.6-sol",
        task="three-body",
        image=f"harnessblog/{harness}:test",
        prompt_hash="abc",
        budget_usd=1,
        timeout_seconds=60,
        seed=1,
    )


def test_all_harnesses_are_forced_through_gateway(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPENROUTER_PROXY_URL", "http://host.docker.internal:8765")
    monkeypatch.setenv("RUN_PROXY_TOKEN", "ephemeral-secret")
    for harness in ("pi", "cline", "hermes", "claude", "codex"):
        item = spec(harness)
        cmd = docker_command(item, tmp_path / harness, adapter_for(harness).command(item))
        joined = " ".join(cmd)
        assert "http://host.docker.internal:8765" in joined
        assert "ephemeral-secret" in joined
    pi_config = json.loads((tmp_path / "pi" / "home" / ".pi" / "agent" / "models.json").read_text())
    assert pi_config["providers"]["openrouter"]["baseUrl"].endswith(":8765/v1")
    assert pi_config["providers"]["openrouter"]["apiKey"] == "$OPENROUTER_API_KEY"


def test_cline_uses_configurable_compatible_provider(monkeypatch):
    monkeypatch.setenv("OPENROUTER_PROXY_URL", "http://host.docker.internal:8765")
    command = adapter_for("cline").command(spec("cline"))[-1]
    assert "--provider openai-compatible" in command
    assert '--baseurl "$OPENAI_BASE_URL"' in command


def test_codex_overrides_image_provider_url(monkeypatch):
    monkeypatch.setenv("OPENROUTER_PROXY_URL", "http://host.docker.internal:8765")
    command = adapter_for("codex").command(spec("codex"))[-1]
    assert 'model_providers.openrouter.base_url="http://host.docker.internal:8765/v1"' in command
