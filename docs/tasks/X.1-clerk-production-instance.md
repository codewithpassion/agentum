---
id: X.1
title: Move Harbourmaster onto the shared production Clerk instance
milestone: X
size: S
status: in_progress
depends_on: []
branch: task/X.1-clerk-production-instance
lane: worker
executor: claude
---

Dom approved one production Clerk instance shared by Harbourmaster, flightdex-v2 and control-plane (26 Oct 2026). The instance is the production instance of the existing Clerk app "Harbourmaster" (`app_3Kk8QOcbXfKKWjg140Gw9SdYCBg`), whose dev instance (faithful-falcon-1887) this repo already uses. The integration coordinator creates the instance, its DNS records and its orgs; the record is `~/devel/ai-os-integration/STATUS.md`. This task is the Harbourmaster side only.

## Scope
- Production env gets the `pk_live_` publishable key and the `sk_live_` secret, replacing the `pk_test_` key in `.env.production.local` and the matching Worker secrets. Staging first, production second, and keep the old values so each step can be rolled back.
- `ALLOWED_ORG_IDS` gets the production org ids (the coordinator recreates "Harbour Edge Intelligence" and "Dev Workspace" on the production instance and records the new ids in STATUS.md).
- Existing `workspaces.clerk_org_id` rows in production D1 point at dev org ids. Add a one-off migration script that maps old org ids to new ones from a JSON file, with a dry-run mode. Users are new on the production instance, so any table keyed by Clerk user id (runs `on_behalf_of_user_id`, inbox authors, api-key owners, OAuth client approvals) needs the same mapping by email.
- OAuth MCP clients approved against the dev instance must be approved again; note this in the log.

## Check
- Staging signs in on the production instance and lands in the mapped workspace.
- The migration script's dry run on a copy of production D1 lists every row it would change, and no row is left pointing at a dev org or user id.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-26: written by the integration coordinator; Dom approved one shared production instance.
- 2026-10-26: Dom: run now, next in the worker lane after V1.16. Prod instance ins_3LDH0LvG5SOMvxgdBIX2kyIj1Sf exists; only org Harbour Edge Intelligence (org_3LDLbiYGe7iohEccrRQuLeBqaX2) so far, per ~/devel/ai-os-integration/STATUS.md.
- 2026-10-26: dispatched. Controller exported production D1 to harbourmaster-wt/tmp/X.1/prod-d1.sql for the dry run; secrets, deploys and the cutover stay with the controller.
- 2026-10-26: code merged at 105e99d (review clean after 0 fix rounds): migrate-clerk-ids, build-clerk-id-map, agent-login staging uses the production key. Cutover waits: production instance lacks the Dev Workspace org and dev@rockyshoreslabs.io; Dom to decide create vs map to HEI.
- 2026-10-26: Dom: create Dev Workspace org and dev@rockyshoreslabs.io on the production instance; asked the coordinator (session devel-9b) for that and for the live keys in .env.production.local.
- 2026-10-26: id-scan follow-up merged (Clerk id shape, ignore list). Staging cut over: 926 cells in 769 rows rewritten (map harbourmaster-wt/tmp/X.1/staging-map-fixed.json, the-brain id ignored), secrets set, ALLOWED_ORG_IDS = new Dev Workspace and HEI orgs, deployed ad9dbcf7 (pk_live). Re-run lists 0 cells. Time Travel bookmark before apply: 000002b7-00000000-00005110-3af4d2709f3fdd629fb063c069de5149. Old values in ~/.config/harbourmaster/rollback-clerk.env. Sign-in check running.
- 2026-10-26: production cut over: 27 cells in 21 rows rewritten (map tmp/X.1/prod-map.json), migration 0013 applied, live secrets, deployed 922c821f; re-run lists 0 cells. Bookmark before apply: 000002a0-00000000-00005110-97a85d110a44cd06f6ea7331aa6ae9d3. Dev user removed from the HEI org on Dom's say, so agent sign-ins land in Dev Workspace. Staging sign-in check passed (tmp/X.1/staging-signin.md). HANDOVER updated.
