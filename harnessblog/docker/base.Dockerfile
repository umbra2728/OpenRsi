FROM nvidia/cuda:12.8.1-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive PIP_BREAK_SYSTEM_PACKAGES=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash build-essential ca-certificates curl ffmpeg git jq python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --no-cache-dir numpy scipy matplotlib pillow pytest
RUN useradd --uid 10001 --create-home --shell /bin/bash agent
WORKDIR /workspace

