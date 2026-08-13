ARG BASE_IMAGE=harnessblog/base:cuda12.8
FROM ${BASE_IMAGE}
ARG VERSION=0.147.0
RUN npm install -g "@openai/codex@${VERSION}"
RUN install -d -o agent -g agent /home/agent/.codex && printf '%s\n' \
    'model_provider = "openrouter"' \
    '[model_providers.openrouter]' \
    'name = "openrouter"' \
    'base_url = "https://openrouter.ai/api/v1"' \
    'env_key = "OPENROUTER_API_KEY"' \
    'wire_api = "responses"' > /home/agent/.codex/config.toml \
    && chown agent:agent /home/agent/.codex/config.toml
USER agent

