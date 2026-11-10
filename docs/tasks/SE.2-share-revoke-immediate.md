---
id: SE.2
title: A revoked share link stops serving files at once
milestone: SE
size: S
status: done
depends_on: []
branch: task/SE.2-share-revoke-immediate
lane: worker
executor: claude
---

From the 10 Nov 2026 review (M3). A revoked share link, and a removed member, keep reading artifact files for up to an hour. Start at `apps/web/src/server/artifact-content/routes.ts` and `packages/services/src/artifacts/shares.ts`.

## Scope

- The content route re-reads the share row (and membership) on each request and refuses a revoked or expired one.

## Check

- A failing test first: revoke a share, then the next content request with the old view token gets a refusal.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
- 2026-11-10: dispatched to a Sonnet implementer on task/SE.2-share-revoke-immediate. Lane rule relaxed for this run (Dom asked for about six in parallel): its files do not overlap the other running tasks, only shared registries, which merge cleanly.
- 2026-11-10: Review clean after 1 fix round. Departure: a removed member's access is cached for 60 seconds to avoid a Clerk call per file, so membership is not re-read on every request. Revoked, expired or switched-off links are refused on the next request. Merged as c03576ba. check, test and build green on main (guest-execution.test.ts failed under full-suite load and passed alone, as on main before).
