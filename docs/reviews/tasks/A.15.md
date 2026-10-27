# A.15 review

## Verdict

Round 0 (head 2ff53ab): clean, nothing must-fix. No fix rounds.

## Scope 1: analytics beacon

Artifact content responses now send `Cache-Control: private, max-age=300, no-transform`. Source: the Cloudflare Web Analytics FAQ ("automatic setup is not working", https://developers.cloudflare.com/web-analytics/faq/) says a `no-transform` Cache-Control stops the proxy from modifying the payload, so the beacon is not injected. The FAQ example is `public, no-transform`, ours is `private, ...`. The docs do not show the `private` form explicitly, so B.10's staging `artifact_test` must confirm the console error and failed request are gone. Fallback if not: filter the beacon's console error and request in the `artifact_test` formatter, and Dom turns off automatic setup in the dashboard.

## Scope 2: workspace name

`forOrg` reads the Clerk organisation name (`clerk-org-name.ts`, cached five minutes per isolate) when it creates a row and when a row's name still equals its org id. It falls back to the id when Clerk has no name or the lookup fails. Tests in `packages/services/src/workspaces.test.ts` and `apps/web/src/server/clerk-org-name.test.ts`.

## Scope 3: staging cron

`env.staging.triggers` is `{ "crons": [] }`. Built with `bun run staging:build`, `apps/web/dist/server/wrangler.json` has `name` `harbourmaster-staging`, `triggers` `{"crons":[]}`, and one route, `harbourmaster-staging.rockyshoreslabs.io` (custom domain). No `crons` entry with a schedule appears anywhere, and `previews` has no `triggers` key, so previews run no cron either. Nothing was deployed.

## Nits left

- The app gateway (`app-gateway/gateway-core.ts:148`, `mount.ts:114`) sets `private, no-store`, which drops `no-transform`. An app API answering `text/html` could still get the beacon.
- A failed Clerk name lookup is not cached, so while Clerk is down every request on a row still named by its org id retries it, with no timeout.
- The rename UPDATE is not a compare-and-set (`AND name = clerk_org_id`).
- The name is trimmed in both `workspaces.ts` and `clerk-org-name.ts`.
- `clerkOrgName` builds its Clerk client at compose time, `clerkPeople` builds lazily.
- A cast on `answers.shift()` in `clerk-org-name.test.ts`.

## Beyond scope

A workspace name never refreshes after Clerk renames the org.
`docs/tasks/A.4` and `docs/v3/artifacts-prd.md:213` still quote the old Cache-Control value.

## Steps for Dom

After B.10 deploys staging, run `artifact_test` once and confirm no beacon error. If it persists, turn off Web Analytics automatic setup for the staging and production zones.
