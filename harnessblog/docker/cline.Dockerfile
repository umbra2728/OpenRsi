ARG BASE_IMAGE=harnessblog/base:cuda12.8
FROM ${BASE_IMAGE}
ARG VERSION=3.0.53
RUN npm install -g "cline@${VERSION}"
USER agent

