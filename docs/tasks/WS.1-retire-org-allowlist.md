---
id: WS.1
title: "A workspace row admits an organisation, and ALLOWED_ORG_IDS goes away"
milestone: WS
size: L
status: done
depends_on: []
branch: task/WS.1-retire-org-allowlist
lane: services
executor: claude
---

Dom's request, 2 November 2026: `ALLOWED_ORG_IDS` was a development placeholder and has to go. Workspace admins will create workspaces in the app (WS.2), which can't work while a new organisation needs a Worker secret edit and a redeploy.

Production's Clerk instance is shared with other apps (`docs/reviews/tasks/X.1.md`), so its organisations can't all be admitted.

## Decisions
- An organisation has access exactly when a `workspaces` row has its `clerk_org_id`. An organisation with no row gets what an unlisted one gets today: no workspace, a 401, the `NoAccess` screen.
- Nothing creates a row on first request any more. `forOrg` only reads, except that it still fills in a name that equals the org id. Rows are made only by the explicit create in this task, which WS.2 calls and the script below calls. A Clerk organisation made anywhere else never gets in.
- No schema change.

## Scope
- `packages/services/src/workspaces.ts`: drop `allowedOrgIds`. Add a create method for system callers that takes `clerkOrgId` and a name and inserts the row, and returns the existing row when there is one.
- Every other use reads the row instead of the list: `machines.ts`, `routines.ts` (its tick walks all workspaces), `triggers.ts`, `artifacts/app-grants.ts`, `artifacts/shares.ts`, `apps/web/src/server/mcp/principal-resolver.ts`, `mcp/oauth-auth.ts`, `live-artifacts/auth.ts`, `server/compose.ts`, `trpc/context.ts`. Mind `oauth-auth.ts`, which walks the list to find the org: it must not call Clerk once per workspace on each request, and a shared-instance organisation with no row must stay out. Keep the existing "a bad org means null" tests and make them mean "no row".
- `add-clerk` keeps a copy of `context.ts`, so that copy changes too.
- `apps/web/scripts/add-workspace.ts` plus pure helpers: `bun run add-workspace --org <id> --name <name> (--local | --remote [--env staging])` creates the first workspace of a deployment, which has no admin to do it. It uses `wrangler d1 execute`, and it checks the organisation exists on the Clerk instance for that environment.
- Dev login stays one click on a clean `.wrangler`: `/api/dev-login`, active only in dev builds, makes the row for the dev organisation. `create-dev-user` stops writing `ALLOWED_ORG_IDS`.
- Remove the variable from `.env.example`, `.env.staging`, `apps/web/.env` handling, generated types, `packages/services/src/secrets.ts`, `scripts/dev/local.ts`, the runner fixtures and the `docs/ux-review/tooling` scripts. The tests that set it either seed a row or drop it. Prefer one shared fixture over editing each test by hand.
- Docs: `CLAUDE.md` (Auth, and Dev login), `README.md`, `apps/web/README.md`, `packages/services/README.md`, `docs/HANDOVER.md`, and the `add-clerk` and `setup-cloudflare` skills, which must tell a new copy to run `add-workspace`. Leave task logs, reviews and old architecture docs alone.
- `apps/web/src/routes/index.tsx`: fix the comment about the list. WS.2 reworks that screen.

## Check
- A test for each of: an organisation with a row gets a principal, one with none gets null on the session, MCP, OAuth, machine, trigger and live-artifact paths, and the first request by a member of an unknown organisation creates no row.
- Routines still tick for every workspace, and a test covers two.
- `grep -rI "ALLOWED_ORG_IDS\|allowedOrgIds" apps packages scripts .claude CLAUDE.md README.md .github` finds nothing.
- `bun scripts/e2e/a2a-two-deployments.ts`, because it signs in through the dev instance and depends on this.
- Browser: `rm -rf apps/web/.wrangler`, migrate, and one-click dev login lands on the desk.
- `bun run check && bun run test && bun run build`, and the grep of `apps/web/dist/client` for `drizzle` finds nothing.

## Rollout, for the controller
A row outside today's allowlist gains access when this ships, and an allowed organisation that has never visited loses it, so in each environment, before deploying: list `workspaces` and compare it with that environment's `ALLOWED_ORG_IDS`. Show Dom any difference, add missing rows with `add-workspace`, and remove the Worker secret after the deploy. Staging is the controller's. Production waits for Dom's go-ahead.

## Log
- 2026-11-02: created from Dom's request.
- 2026-11-02: dispatched.
- 2026-11-02: review clean after 1 fix round. Merged and pushed. Not deployed: the rollout comparison in each environment comes first.
- 2026-11-02: deployed to staging at c222660d (Worker version 21e568dd). All 10 rows matched the staging list, and the staging Worker secret is deleted. Sign-in still lands on the desk. Production not deployed.
