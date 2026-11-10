---
id: SE.4
title: Rotation path for SECRETS_KEY and RUN_TOKEN_KEY
milestone: SE
size: M
status: done
depends_on: []
branch: task/SE.4-key-rotation
lane: services
executor: claude
---

From the 10 Nov 2026 review (M4). Neither key can be rotated today (`packages/services/src/crypto.ts`).

## Scope

- Decrypt accepts a second, older key. Encrypt always uses the current one.
- A script in `apps/web/scripts` re-encrypts every encrypted column under the current key, dry run unless `--apply`.
- Run tokens verify against the current and the previous key.
- A short runbook in `docs/`.

## Check

- Tests: a value written under the old key reads under the new pair, the script moves it, and it then reads with the new key alone.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
- 2026-11-10: dispatched to a Sonnet implementer on task/SE.4-key-rotation. Lane rule relaxed for this run (Dom asked for about six in parallel); files checked against the other running tasks. Runs before CL.4, which also changes crypto.ts.
- 2026-11-10: Dom dropped per-task reviews for a review per milestone. This task's review was already running, so it finished and its must-fix items were applied.
- 2026-11-10: Merged as c9d44c3f. check, test and build passed on main at dfd75103, and the bundle grep was empty. guest-execution.test.ts passed in that run.
