# An agent's computer: Debian plus the tools an agent expects, with computerd
# holding the door. The same image serves both modes - Fly passes
# COMPUTERD_MODE=listen, a self-hosted container keeps the default below.
#
# Bun is copied from the official image rather than installed over the network,
# so the build needs nothing but the two registries.
FROM oven/bun:1.3-slim AS bun

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# libstdc++6 is Bun's only shared-library requirement beyond what slim ships;
# everything else here is for the agent, not for the daemon. `apt` stays in the
# image on purpose - an agent may install more - but only what lands under
# /home/agent survives a restart.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    git \
    jq \
    libstdc++6 \
    nodejs \
    python3 \
    python3-pip \
    ripgrep \
    sqlite3 \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# uid 1000 so a bind-mounted host directory belongs to the usual first user;
# rootless Podman needs --userns=keep-id to line up, see the README.
RUN useradd --create-home --home-dir /home/agent --shell /bin/bash --uid 1000 agent

WORKDIR /app
COPY src ./src

# The computer's files, and the only thing that persists. Declared after the
# home directory exists so the volume inherits its ownership.
VOLUME ["/home/agent"]

ENV COMPUTERD_MODE=connect \
    COMPUTERD_ROOT=/home/agent \
    COMPUTERD_PORT=8080

EXPOSE 8080
USER agent
CMD ["bun", "run", "src/main.ts"]
