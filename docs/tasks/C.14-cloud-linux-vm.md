---
id: C.14
title: Linux VM backend for cloud agents (Sandbox SDK microVM)
milestone: C
size: L
status: done
depends_on: [C.12, C.13]
branch: task/C.14-cloud-linux-vm
---

Asked for by Dom on 17 Oct 2026. Cloud agents (Pi in the `PiRun` Durable Object) run skill scripts in a Dynamic Worker isolate (C.12), and Pi's file tools work on the library through just-bash (C.8). Neither is a real Linux machine. Cloudflare's `cloudflare/claude-managed-agents` template (https://github.com/cloudflare/claude-managed-agents) runs a Sandbox SDK microVM on Cloudflare Containers per session, with R2 snapshots. Reuse that sandbox approach for our own cloud agents. The Anthropic webhook and work-queue parts of the template aren't needed.

## Scope

First slice, as Dom approved:
- A Linux VM backend using `@cloudflare/sandbox` (pin the exact version), one VM per session, put to sleep or destroyed when idle. Add the container class and Durable Object binding at the top level, `env.staging` and `env.staging.previews` in `wrangler.jsonc`, with migration tag `v4` after `v3`. Add the container image (Dockerfile) with bun and node.
- An agent setting to pick the cloud agent's environment: "isolate" (today's behaviour, the default) or "Linux VM". With Linux VM:
  - Pi's built-in `bash`, `read`, `write` and `edit` run in the VM's file system.
  - `run_skill_script` runs through the VM backend behind C.12's port, with bun running the `.ts` file directly.
  - The agent's skills and the run's input files are placed in the VM's workdir.
  - The workspace library stays reachable through the platform tools.
- The session's workdir is snapshotted to R2 when the VM sleeps, and restored on the next run, so files survive between messages.
- Network on, with no allowlist proxy in this slice. Scripts and shell commands never see Harbourmaster secrets, run tokens or the workspace key.
- The agent form explains the trade-off: a VM takes seconds to start and is billed while running.

## Check

Unit tests with the sandbox behind a port and a fake behind it: backend selection per agent, file placement, the snapshot and restore calls, time and output caps. Live on a local dev server, with Docker and the workspace key from `apps/web/.env.local` in the local dev database. A Linux VM cloud agent:
- runs `uname -a` and `bun --version` through its shell
- runs the `ts-hello` skill script and replies with the codeword
- runs a script that uses `node:fs` to write a file, and that file is still there in a second message after the VM went to sleep
- runs a `fetch("https://example.com")` and gets 200

An isolate agent still works as before. The controller repeats the check on staging after deploy. `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` passes.

## Log
- 2026-10-17: added at Dom's request; dispatched on task/C.14-cloud-linux-vm.
- 2026-10-17: review clean after 3 fix rounds (extra rounds allowed by controller) at c453291 (docs/reviews/tasks/C.14.md). Merged. VM live check not run locally (workerd container sidecar fails on this host); staging check pending. No secrets reach the VM until S.4.
- 2026-10-17: deployed to staging (Containers worked, image pushed, VmSession v4). R2 lifecycle rule vm-snapshots-30d on harbourmaster-staging-files. Staging VM live check running.
