#!/usr/bin/env bash
set -euo pipefail

docker run --rm harnessblog/pi:0.84.1 pi --version
docker run --rm harnessblog/cline:3.0.53 cline --version
docker run --rm harnessblog/hermes:v2026.8.3 hermes version
docker run --rm harnessblog/claude:2.1.228 claude --version
docker run --rm harnessblog/codex:0.147.0 codex --version
docker run --rm harnessblog/ouroboros:6.100.0 ouroboros --help >/dev/null
