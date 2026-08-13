#!/usr/bin/env bash
set -euo pipefail

docker build -f docker/base.Dockerfile -t harnessblog/base:cuda12.8 .
docker build -f docker/pi.Dockerfile --build-arg VERSION=0.84.1 -t harnessblog/pi:0.84.1 .
docker build -f docker/cline.Dockerfile --build-arg VERSION=3.0.53 -t harnessblog/cline:3.0.53 .
docker build -f docker/hermes.Dockerfile --build-arg VERSION=v2026.8.3 -t harnessblog/hermes:v2026.8.3 .
docker build -f docker/claude.Dockerfile --build-arg VERSION=2.1.228 -t harnessblog/claude:2.1.228 .
docker build -f docker/codex.Dockerfile --build-arg VERSION=0.147.0 -t harnessblog/codex:0.147.0 .
docker build -f docker/ouroboros.Dockerfile --build-arg VERSION=6.100.0 -t harnessblog/ouroboros:6.100.0 .
