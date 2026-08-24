"""Harbor optimizer-agent adapter for OpenRSI.

Modeled on ``harbor/agents/installed/pi.py``. OpenRSI is a Node/TypeScript app
built on the pi coding-agent *library* (not the `pi` CLI), so this adapter clones
the OpenRSI integration branch into the container, builds it, and execs its
HarnessOpt entry point as the `main` optimizer. OpenRSI then edits ``/work/agent``,
scores candidates via the ``evals`` sidecar, and ``evals submit``s its champion.

Deploy: ``scripts/register_openrsi_agent.sh`` copies this file into the installed
``harbor/agents/installed/`` package and registers the ``openrsi`` name, so
``vero harbor run --agent openrsi`` resolves it.

Env consumed at run time (the gateway/producer-scope vars are injected by Harbor
for OpenAI-compatible agents, exactly as for ``codex``):
  OPENAI_BASE_URL / OPENAI_API_KEY   producer-scope gateway
  OPENRSI_GIT_URL   git URL of the OpenRSI integration checkout (required)
  OPENRSI_GIT_REF   ref/branch/sha to build (default: main)
  plus any OPENRSI_* knobs, forwarded verbatim.
"""
from typing import override
import os
import shlex

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class OpenRsi(BaseInstalledAgent):
    """OpenRSI generational harness optimizer."""

    SUPPORTS_RESUME: bool = False
    _OUTPUT_FILENAME = "openrsi.txt"
    # Clone OpenRSI under the agent's writable $HOME. /work/agent is the TARGET
    # (edited/scored) and /work is root-owned, so the unprivileged agent cannot
    # create /work/openrsi.
    _CHECKOUT = "$HOME/openrsi"

    @staticmethod
    @override
    def name() -> str:
        # Registered into harbor.models.agent.name.AgentName by the deploy script.
        return "openrsi"

    @override
    def get_version_command(self) -> str | None:
        return "cat \"$HOME/openrsi/package.json\" | grep '\"version\"' | head -1"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip() or "0.1.0"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y curl git",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        git_url = os.environ.get("OPENRSI_GIT_URL")
        git_ref = os.environ.get("OPENRSI_GIT_REF", "main")
        if not git_url:
            raise ValueError("OPENRSI_GIT_URL must be set to the OpenRSI integration checkout")
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"git clone {shlex.quote(git_url)} \"$HOME/openrsi\" && "
                f"cd \"$HOME/openrsi\" && git checkout {shlex.quote(git_ref)} && "
                "npm ci --no-audit --no-fund && npx tsc -p tsconfig.json && "
                "test -f dist/runHarnessOpt.js"
            ),
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise ValueError("model_name is required (the optimizer model)")

        # Route model calls through the metered gateway, NOT the host upstream.
        # Harbor injects the compose-internal gateway base_url + a producer-scope
        # token into the AGENT env; codex reads them via self._get_env, so we do
        # the same. Reading os.environ here would leak the host's OpenRouter creds
        # into the container and bypass metering (conformance step 1 fails).
        env: dict[str, str] = {"OPENRSI_OPTIMIZER_MODEL": self.model_name, "OPENRSI_PROVIDER": "openai"}
        for key in ("OPENAI_BASE_URL", "OPENAI_API_KEY"):
            val = self._get_env(key)
            if val:
                env[key] = val
        # OPENRSI_* knobs are our own config (generations, subset sizes, git ref) —
        # those legitimately come from the host process env.
        for key, val in os.environ.items():
            if key.startswith("OPENRSI_"):
                env[key] = val

        escaped = shlex.quote(instruction)
        await self.exec_as_agent(
            environment,
            command=(
                f". ~/.nvm/nvm.sh; cd \"$HOME/openrsi\"; "
                f"node dist/runHarnessOpt.js {escaped} "
                f"2>&1 | stdbuf -oL tee /logs/agent/{self._OUTPUT_FILENAME}"
            ),
            env=env,
        )
