ARG BASE_IMAGE=harnessblog/base:cuda12.8
FROM ${BASE_IMAGE}
ARG VERSION=0.84.1
RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${VERSION}"
USER agent

