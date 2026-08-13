ARG BASE_IMAGE=harnessblog/base:cuda12.8
FROM ${BASE_IMAGE}
ARG VERSION=2.1.228
RUN npm install -g "@anthropic-ai/claude-code@${VERSION}"
USER agent

