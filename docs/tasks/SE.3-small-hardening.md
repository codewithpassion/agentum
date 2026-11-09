---
id: SE.3
title: Small hardening from the review
milestone: SE
size: S
status: in_progress
depends_on: []
branch: task/SE.3-small-hardening
lane: worker
executor: claude
---

From the 10 Nov 2026 review. Each item is small and independent.

## Scope

- Register `/api/dev-login` only in dev builds (`import.meta.env.DEV`), on top of the env variable check (`apps/web/src/server.ts`).
- `/api/health` stops returning `userId`.
- Set the `global_fetch_strictly_public` compatibility flag, in all three wrangler places (top level, `env.staging`, `env.staging.previews`). Confirm dev loopback peers still work in dev builds.
- The CIMD client-name fetch (`apps/web/src/server/mcp/cimd-client-name.ts`) goes through the safe URL guard.
- The app refuses to start guest and view links when `ARTIFACT_VIEW_KEY` is unset, with no fallback key (`live-artifacts/guest-infra.ts`).
- `run_requests.question_keys` and question text pass the masker before storage (`packages/services/src/requests.ts`).
- The assistant never stores or resends a trigger secret: exclude `create_trigger` in `packages/mcp/src/assistant.ts`, or mask the secret in the stored result.
- The enrolment code is spent in the same `atomic` call as the machine insert (`packages/services/src/machines.ts`, `enroll`).
- `packages/services/README.md` states the trust rule Dom set on 10 Nov 2026: every workspace member may manage secrets, keys and grants. Say that the admin check on a secret's mode change is not a boundary.

## Check

- A test per behaviour change.
- `bun run check && bun run test && bun run build` pass, and the bundle grep stays clean.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
- 2026-11-10: dispatched to a Sonnet implementer on task/SE.3-small-hardening. Lane rule relaxed for this run (Dom asked for about six in parallel): its files do not overlap the other running tasks, only shared registries, which merge cleanly.
