---
id: A.6
title: Wiring, share route, thumbnail, tick and bindings
milestone: A
size: L
status: done
depends_on: [A.2, A.3, A.4, A.5, A.12]
branch: task/A.6-wiring
lane: worker
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD). A.1 holds every schema change, shared constant, protocol schema and seam; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations, and works against A.1's types. Integration branch: `v3/artifacts`.

## Scope
- Build the artifacts and shares services in `composeWith` (`apps/web/src/server/compose.ts`) and add them to `Services`.
- In `apps/web/src/server.ts`: mount the A.4 content routes before the TanStack fall-through, with content paths skipping `clerkMiddleware()` and the compose middleware; add the `frame-ancestors 'none'` middleware for every non-content response and `Referrer-Policy: no-referrer` on `/a/*` and `/s/*` pages (R1.21a).
- A Hono route file for `POST /api/share/:token/open` (rate limited per token and per IP prefix, 429 above the limit, R1.35; same 404 body for every refusal) and `GET /api/artifacts/:id/thumbnail?version=<n>` (session, `/files` headers).
- MCP port adapters wiring `ArtifactsPort` (A.5) to the services, and the `artifact_test` adapter: mint a test token (A.3), run the A.12 driver, save the screenshot in the run's task folder through the library, set the version thumbnail, record the view.
- `artifact.published` in `STREAM_EVENT_TYPES` (`session-stream-frames.ts`).
- Tick job calling the A.3 prune (`apps/web/src/server/tick/`).
- `apps/web/wrangler.jsonc`: var `ARTIFACT_LINKS_OFF`, a Workers Rate Limiting binding for share opens, each in three places (top level, `env.staging`, `env.staging.previews`); secret `ARTIFACT_VIEW_KEY` in `.env.example` and `.env.local` generation notes; `wrangler types` regenerated.

## Check
- Route tests for R1.29, R1.35, R1.36 and R1.21a (a non-content route and a content route, headers asserted).
- An MCP round trip from a run token through `artifact_create`, `artifact_update` and `artifact_test` with a fake browser driver.
- `compose.test.ts` passes; `bun run check && bun run test && bun run build` pass; the bundle grep for `drizzle` in `apps/web/dist/client` is empty.
- Local smoke: `vite dev`, dev login, create an artifact through the MCP route, open its member content URL framed and directly (302), and a link open from a fresh browser.

## Refinements (2026-10-27, from merged tasks)
- A.5: `McpPorts.artifacts` is optional and the five tools only appear when it is set. Wire it in `apps/web/src/server/mcp/ports.ts`; the MCP round trip must list all five tools.
- A.4: `mountArtifactContentRoutes(app, { bucket, viewKey, workspaceId, nowSeconds? })` is not mounted yet. Pass `workspaceId: (claims) => claims.workspaceId`; A.3 adds that claim to the view token. The content route never touches D1.
- A.12: use `artifactTestBrowser(env.BROWSER)` from `browser-run.ts` with `runArtifactTest` and `formatArtifactTestResult` from `apps/web/src/server/artifact-test/`. Local Browser Run needs `CI=1` on `vite dev`.
- A.9: `artifacts.list` takes `runId` (A.2 filters on it).
- A services test ("an hour of never-claimed runs stays bounded") can time out on a busy host. Re-run it before treating it as a failure.

More refinements (2026-10-27, after A.2, A.3, A.4, A.8 merged)
- A.2: build `createArtifactsService({db, atomic, blobs, clock, events, library, people})` and add `artifacts` to `Services`; replace the `artifactsOf(ctx)` accessor in `artifacts-router.ts` with `ctx.services.artifacts`. It returns no `url`; the MCP adapter adds `https://<app>/a/<artifactId>`. Map `ServiceError` `invalid` to the tool's `validation` code.
- A.3: add `artifactShares` to `Services` (`createArtifactSharesService({ atomic, clock, db, events, linksOff, origin, people, secretsKey, viewKey })`), delete the `sharesService` cast helper in `artifact-shares-router.ts`, run `prune()` daily from the tick.
- A.4: the `frame-ancestors 'none'` middleware must skip `/a/<uuid>/c/` paths (they set their own `frame-ancestors`).
- A.8 found no way to list a version's files: add a `files` list (path, size, contentType) to the `artifacts.versions` or `artifacts.get` output for the shown version, plus `GET /api/artifacts/:id/download?version=<n>` (session, zip of the version's files, `attachment`), which A.8's Download menu item already calls. Then pass `dataFiles` (non-entry files) from the viewer to `ShareDialog`.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
- 2026-10-27: ready at 0468eb2, review clean after 1 fix round; needs ARTIFACT_VIEW_KEY secret per environment; merged.
