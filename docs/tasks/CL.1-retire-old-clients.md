---
id: CL.1
title: Retire the TypeScript daemon and the Go computer
milestone: CL
size: L
status: blocked
depends_on: []
branch: null
lane: ops
executor: claude
---

From the 10 Nov 2026 review. Three machine clients are still built and released: `apps/agentum` (Rust), `apps/daemon` (TS) and `apps/computer` (Go). Blocked until Dom confirms every production machine runs the Rust client.

## Scope

- Move what the Rust build still needs out of `apps/computer` (`packaging/desktop`, `testdata/protocol`).
- Remove `apps/daemon`, `apps/computer`, `.github/workflows/computer.yml`, the old products in `packages/protocol/src/releases.ts` and the old install scripts.
- Old install URLs answer with a message that points to the new command.

## Check

- A production query shows no machine on an old client in the last 14 days.
- `bun run check && bun run test && bun run build` pass, and the Rust build and its tests pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
