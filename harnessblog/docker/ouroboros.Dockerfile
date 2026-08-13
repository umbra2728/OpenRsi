ARG BASE_IMAGE=harnessblog/base:cuda12.8
FROM ${BASE_IMAGE}
ARG VERSION=6.100.0
USER root
RUN git clone --depth 1 --branch "v${VERSION}" https://github.com/razzant/ouroboros.git /opt/ouroboros \
    && sed -i '/^pip==/d' /opt/ouroboros/requirements-runtime.lock \
    && python3 -m pip install --no-cache-dir -r /opt/ouroboros/requirements.txt \
    && python3 -m pip install --no-cache-dir --editable /opt/ouroboros --no-deps \
    && install -d -o agent -g agent /home/agent/Ouroboros/data
USER agent
