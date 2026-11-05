# Build the static artifacts first with scripts/build-all.sh. Context: repository root.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini procps \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1000 agentum \
  && mkdir -p /var/lib/agentum/config /var/lib/agentum/state \
  && chown -R 1000:1000 /var/lib/agentum
ARG TARGETARCH
COPY --chmod=0755 apps/agentum/dist/agentum-linux-* /tmp/binaries/
RUN case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) exit 1 ;; esac \
  && mv "/tmp/binaries/agentum-linux-$arch" /usr/local/bin/agentum \
  && rm -rf /tmp/binaries
USER 1000:1000
ENV HOME=/home/agentum \
    AGENTUM_CONFIG_DIR=/var/lib/agentum/config \
    AGENTUM_STATE_DIR=/var/lib/agentum/state
VOLUME ["/var/lib/agentum"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agentum", "run"]
