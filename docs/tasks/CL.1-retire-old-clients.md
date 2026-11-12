---
id: CL.1
title: Retire the TypeScript daemon and the Go computer
milestone: CL
size: L
status: done
depends_on: []
branch: task/CL.1-retire-old-clients
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
- 2026-11-11: Dom said "Switch it now". Production machine morosini-prod moved to the Rust client (new machine "morosini", 0.1.0+b4c01389), bruce-meetings ran on it, and hm-daemon-production is stopped and disabled. The morosini-prod row stays unrevoked as the rollback path until CL.1 is on production. Dom's go replaces the 14-day window in the check. The staging daemon on Morosini moves to the Rust client before this merges. Dispatched.
- 2026-11-11: staging daemon on Morosini switched (machine "morosini-staging", throwaway agent ran, hm-daemon-staging stopped and disabled). Review clean, merged as 6f76c5a3, gate passed. Staging and production deploy next.
- 2026-11-11: on staging (Worker 45d1ce0c) and production (Worker 4918f335, bookmark 00000034-00000038-00005120-5a40457221c769cc1aa0de13f130a6c1, no migrations). Old install URLs print the pointer, retired releases 404, Machines page works, morosini online on 0.1.0+b4c01389. morosini-prod row still unrevoked, waiting on Dom.
- 2026-11-12: Dom approved the follow-ups. morosini-prod revoked on production (bookmark 00000037-0000076a-00005121-d56d4cd36c43febea8272486d8be1dc9, no agents bound to it), so the leaked hm_mach_ credential and the hm-daemon-production rollback are gone. Client release 0.1.0+ee1dcb6b published to staging and production R2 (Zig 0.14.1 installed under ~/.local). Both Morosini instances updated to it, came back connected, and bruce-meetings ran on production. The morosini-build worktree was already gone. The Machines page offered older builds as updates, which became CL.6.
