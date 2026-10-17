# The Linux VM of a cloud agent session (task C.14). `@cloudflare/sandbox` talks
# to it through `sandbox-shim`, whose tag must match the package version in
# apps/web/package.json.
FROM node:24-trixie-slim

COPY --from=docker.io/cloudflare/sandbox:1.0.1 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# bun runs the skill scripts' .ts files directly. Keep the tag near the bun in package.json's packageManager.
COPY --from=docker.io/oven/bun:1.3.11 /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    ripgrep \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# No /workspace here: the VM makes it after it starts (or restores it from the
# session's snapshot), because a restore cannot replace a folder that comes from
# the image when it runs under wrangler dev.
CMD ["sleep", "infinity"]
