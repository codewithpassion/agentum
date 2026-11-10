# SE.2 review: a revoked share link stops serving files at once

## What changed

The content route (`apps/web/src/server/artifact-content/routes.ts`) now calls an `authorizeViewer` dep on each request, after the token check. `viewer-check.ts` decides: a token with `shareId` re-reads the share row through `shareState` (no cache), and a token with `userId` asks membership through `memberPrincipal`. A refusal is a 404 with no-store. A proposed version's test token now carries `userId` so a removed member loses it too.

## Verdicts

- Round 1 (0282d29c): not clean. Two must-fix: a Clerk call per member file request, and a proposed-version test token with no `userId`.
- Round 2 (296da235, fix commit only): clean.

## Decisions to know

- A member's positive membership answer is kept for 60 seconds in the isolate (`viewerPorts`), so a removed member is out within a minute, not on the next request. A link revoke, expiry or switch-off is immediate. The task text says "(and membership) on each request"; the cache is deliberate, to avoid one Clerk call per asset.

## Nits left

- `mintTestToken` (`artifact_test`) still signs test tokens with no `userId`. They live 5 minutes.
- `memberYes` in `viewer-check.ts` is never swept; it grows by one entry per user and workspace pair per isolate.
- Allowed responses still send `private, max-age=300`, so a browser may replay a file it already fetched for up to 5 minutes after a revoke. The server refuses at once.
- `compose(env, false)` builds the service graph on each content request. The read-only caller list in `app-gateway/exports.test.ts` now allows this call (count 3).

## Beyond scope

- Do the same fresh share check for the app gateway's member path if it ever needs a cheaper membership read.

## Not verified

- Staging checks (the controller runs them after the merge): revoke a real link and reload the viewer, remove a member and wait a minute.
- `guest execution: HTTP cap/start, durable recovery, signed MCP and suggestions` (`apps/web/src/server/live-artifacts/guest-execution.test.ts`) fails with `fetch failed / ECONNRESET` after about 50 seconds. It fails the same way on a clean checkout of main in this environment, so `bun run test` is red here for that test only. Everything else passes, and `bun run check` and `bun run build` pass. The drizzle grep over `apps/web/dist/client` finds nothing.

## Steps for Dom

None.
