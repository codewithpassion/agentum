# CL.2 review: one guards module for services

## Verdicts

- Round 1 (8e71cbf0): must-fix. Two inline session checks were left in `artifacts/endpoints.ts` (`requireManager`) and `artifacts/grants.ts` (`decideGrant`).
- Round 2 (21584684, fix commit only): clean.

## What changed

- `packages/services/src/guards.ts` holds `requireUser` (any person), `requireSession` (browser session only), `readableWorkspace` and `effectiveOwner`, with `guards.test.ts`.
- `api-keys.ts` had a third meaning (session, or an admin key). It is now `requireSessionOrAdminKey` and stays local.
- `invalid` and `notFound(message = "Not found")` live in `errors.ts`. `idString`, `hostOf` and `TRAILING_SLASHES` live in `shared.ts`. Messages are unchanged.
- No existing test was edited.

## Nits left

- `workspaces.ts` (two sites) and a few other `via === "session"` checks combine the session test with an admin or other condition, so they stay inline.
- Local `UserPrincipal` aliases remain in `agents.ts`, `agent-profile.ts`, `connectors.ts` and `slack-apps.ts`. `a2a/access.ts` keeps `SessionUser` (same type, used by `requireReader`).
- `browser/service.ts` `hostOf` returns a hostname through `validateUrl`, a different meaning, so it stays. `apps/web` `web-fetch.ts` has its own `hostOf` in another package.
- Other copies of the `idString` schema under different names (`tasks/service.ts`, `requests.ts`, `map.ts` and more) and `invalid`/`notFound` variants with different messages (`artifacts/manifest.ts`, `live-artifacts/import-images.ts`, `a2a/push-configs.ts`) were left.
- Biome added a blank line between header comments and imports in some files.

## Ideas beyond the scope

- An assertion-style guard would let `requireSession` replace the remaining inline checks without renaming `principal` after it.

## Not verified

- No staging checks apply to this task. No browser check was needed.

## Steps for Dom

None.
