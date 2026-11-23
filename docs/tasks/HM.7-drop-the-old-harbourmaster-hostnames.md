---
id: HM.7
title: "Drop the old harbourmaster hostnames"
milestone: HM
size: S
status: done
depends_on: []
branch: null
lane: web-infra
executor: claude
---

Dom, 2026-11-23: remove the old harbourmaster hostnames.

The controller checked a week of zone traffic (2026-11-16 to 2026-11-23). `harbourmaster.rockyshoreslabs.io` and `harbourmaster-staging.rockyshoreslabs.io` got only vulnerability scanners: no daemon, computer client, webhook, A2A peer or install. So the legacy-host support can go.

## Scope

1. `apps/web/wrangler.jsonc`: drop both custom-domain routes (prod and staging) and every `LEGACY_HOSTS` var. Regenerate `worker-configuration.d.ts` the way the repo does (`cf-typegen`).
2. Delete the legacy-host middleware (`src/server/legacy-host.ts`, its test, and its wiring in `src/server.ts`), since nothing will feed it.
3. Keep the A2A extension URIs in `packages/a2a/src/extensions.ts` exactly as they are. They are identifiers that peers compare as strings, not URLs anyone fetches.
4. Grep the rest of the repo (docs excluded) for the two hostnames and fix any live reference you find, such as install scripts, env examples or the agentum-rs daemon defaults.

The controller detaches the custom domains in Cloudflare after deploy. Do not touch Cloudflare.

## Check

- `bun run check` and the changed packages' tests and build pass.
- `grep -rn "harbourmaster.rockyshoreslabs\|harbourmaster-staging.rockyshoreslabs"` over apps/ packages/ scripts/ (excluding dist and node_modules) finds only the A2A extension URIs.

## Log
- 2026-11-23: added by controller from Dom's request, after a traffic check.
- 2026-11-23: dispatched.
- 2026-11-23: merged at 288a8eee, review clean after 0 fix rounds.
