---
id: A.15
title: Phase 1 staging follow-ups (analytics beacon, workspace name, staging cron)
milestone: A
size: S
status: in_progress
depends_on: [A.11]
branch: task/A.15-staging-followups
lane: worker-content
executor: claude
---

Findings from A.11's staging check (`docs/reviews/tasks/A.11.md`). Integration branch: `v3/artifacts`. No deploy in this task; B.10's staging deploy picks it up.

## Scope
1. Cloudflare Web Analytics injects its beacon into artifact HTML on staging and production, so every `artifact_test` reports one console error and one failed request. Stop the injection from the content route: add `no-transform` to the content responses' `Cache-Control` (confirm from Cloudflare docs that automatic injection respects it, and record the source). If it does not, filter the beacon's known console error and request in the `artifact_test` formatter as a fallback, and note that Dom can turn off automatic setup in the dashboard. Update the header tests.
2. The share page shows "Shared from org_…" because workspace rows are created with `name = clerkOrgId`. Set the name from the Clerk organisation's name when a workspace is created, refresh it when a member's request sees a row whose name still equals its org id, and fall back to the id only when Clerk has no name. Tests for both.
3. `env.staging` inherits the top-level `triggers`, so the deploy registered the minute cron on `harbourmaster-staging`, against the comment in `wrangler.jsonc`. Give `env.staging` its own `triggers` with no crons (`"crons": []`), and keep `env.staging.previews` consistent. Confirm with `bun run staging:build` that the built `dist/server/wrangler.json` has no crons and still names only the staging Worker and hostname. Don't deploy.

## Check
- Tests for 1 and 2; the built-config grep for 3 recorded in `docs/reviews/tasks/A.15.md`.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned from A.11's findings and dispatched (controller).
