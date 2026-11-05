---
id: RC.6
title: Release, install script, Machines page, Docker image
milestone: RC
size: M
status: ready
depends_on: [RC.1, RC.3, RC.4, RC.5]
branch: RC-rust-client
lane: ops
executor: codex
---

Spec: `docs/v3/machine-client.md` ("Release and install (RC.6)"); today's pipeline in `docs/v3/machine-client/inventory.md` section 5.

## Check
- Both musl binaries build; `publish-releases.ts --dry-run` (add the flag if missing) lists the `agentum-rs` files and a `latest.json` in today's line format; the old products are untouched.
- `/install-agentum.sh` is served and tested like the other two scripts.
- The Machines page shows the new command first and the old ones under "Older clients".
- The Dockerfiles build.
- `bun run check && bun run test && bun run build` and the bundle grep pass.

## Log
