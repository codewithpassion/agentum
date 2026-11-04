# EP.4 implementation handoff

Implemented in `fdcc7bf0` (tests first) and `7ada4248` (implementation and e2e), with final verification fixes in the next commit.

The MCP app example is inline in `artifact_create`'s kind schema and the app kind filter. The create, update and promote descriptions point there. `discordBotFiles` supplies both that example and the files published by the e2e script.

User artifacts retain user ownership. New grants from keys and OAuth clients remain pending; `decideGrant` and answers to run promotion approval requests require a session. MCP user grants appear as individual browser decisions in Needs you, including the endpoint caller-authentication notice. Endpoint URLs in `artifact_read` always describe the active, approved live version, including when reading an older file version.

## Interpretation of the spec

- Preserve the existing user-author publish convention. MCP user apps publish with pending new grants, whereas run-authored apps remain proposed until promotion. The endpoint still cannot resolve before its grant is approved. MCP user promotion returns waiting without a run request id; its individual grant cards are the browser approval path. This is documented next to the promotion code.
- The example uses a proxy secret rule (`Authorization: Bot {value}`). Existing app outbound code injects proxy headers; it does not fill env-secret placeholders. The source holds a placeholder and never the secret value.
- The reply edits Discord's deferred original interaction response using PATCH `/messages/@original`, providing the eventual answer after a type 5 acknowledgement.

## Verification

PASS: `bun run check` (lint, 13 typecheck tasks, boundary lint).

PASS: affected tests, 1,134 total:

- `bun run --cwd packages/db test src/atomic.test.ts`: 5.
- `bun run --cwd packages/mcp test`: 418.
- `bun run --cwd packages/services test src/artifacts src/requests.test.ts src/desk.test.ts src/rail.test.ts`: 538.
- `bun run --cwd apps/web test src/server/mcp/artifact-ports.test.ts src/server/mcp/automation-ports.test.ts src/server/routes/mcp.test.ts src/server/app-gateway/handoff.test.ts src/server/app-gateway/app-host-core.test.ts src/server/app-gateway/endpoints.test.ts src/server/trpc/artifacts-phase2-router.test.ts src/components/rail-pane/pane-logic.test.ts`: 173.

PASS: `bun scripts/e2e/app-bot.ts`. Starts its own vite dev server on a free port other than 3000, uses an API key over HTTP MCP, and approves grants through the existing tRPC routes with a real Clerk session. Asserts signature rejection, PING, direct role assignment with injected credential, agent hand-off, token state, reply delivery, no user on whose behalf the run starts, and disable returning 404. A temporary Vite transform redirects only AppOutbound's final transport to a local mock after host and secret checks. The published example is unchanged; no production mock route is added. Cleanup stops the server, revokes its Clerk session and removes the temporary Vite config. Successful run logs: `/tmp/agentum-app-bot-CBgiQ4`.

Browser check: skipped as instructed; Claude must publish through MCP, approve in Needs you, copy the address from settings, call it, disable it, then confirm 404.

Cold-start check: skipped as instructed; Claude must dispatch a fresh agent with only MCP tools and record its transcript summary here.

Repository-wide `bun run test` and `bun run build`: not run, as instructed. No schema, migration, wrangler configuration or real secret changes; no deployment or push.
