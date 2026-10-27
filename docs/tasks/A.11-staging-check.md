---
id: A.11
title: Phase 1 staging deploy and check
milestone: A
size: M
status: todo
depends_on: [A.14]
branch: null
lane: staging
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD). A.1 holds every schema change, shared constant, protocol schema and seam; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations, and works against A.1's types. Integration branch: `v3/artifacts`.

## Scope
- PRD A.11, run by its dispatcher with the controller's permission for staging only:
  - Before deploying: every new binding and var in three places in `wrangler.jsonc`; `ARTIFACT_VIEW_KEY` set with `wrangler secret put ARTIFACT_VIEW_KEY --env staging`; remote D1 migrations for staging only.
  - Deploy only with `bun run staging:deploy` from `apps/web`. Before it, build with `bun run staging:build` and grep `dist/server/wrangler.json` for `name`, `routes` and `custom_domain`, and confirm they are the staging Worker and staging hostnames. Never deploy production, never hand-roll a wrangler deploy command.
  - Sign in with `bun run agent-login --env staging`.
- One agent per runtime that is available on staging (cloud isolate, Linux VM, Managed Agents, a machine if one is connected) makes a page, a doc and a dashboard and tests them; open each from the thread, the task view, `/artifacts` and at phone width; the R1.19 probes framed and opened directly in Chrome through agent-browser; links created, opened, revoked and expired from a fresh browser; switch off; access log read. The minute tick runs only on production, so R1.33 stays covered by unit tests.
- Record results in `docs/reviews/tasks/A.11.md`, with the Safari probe listed as Dom's step.

## Check
- Every R1 requirement has a pass line with evidence, or a line naming what blocks it.

## Log
- 2026-10-27: planned (controller).
