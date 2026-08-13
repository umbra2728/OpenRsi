ARG BASE_IMAGE=harnessblog/base:cuda12.8
FROM ${BASE_IMAGE}
ARG VERSION=v2026.8.3
RUN git clone --depth 1 --branch "${VERSION}" https://github.com/NousResearch/hermes-agent.git /opt/hermes \
    && python3 -m pip install --no-cache-dir --editable /opt/hermes
USER agent
