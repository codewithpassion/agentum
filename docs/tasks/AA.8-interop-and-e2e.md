---
id: AA.8
title: "Interop with the official A2A SDK and TCK, two-deployment end to end, docs"
milestone: AA
size: M
status: todo
depends_on: [AA.4, AA.5, AA.6, AA.7]
branch: null
lane: ops
executor: claude
---

Spec: `docs/v3/agent-connections.md`. This task proves the claim that we speak A2A, using code we didn't write.

## Scope
- `scripts/e2e/a2a-interop.ts`: starts a local server and drives it with `@a2a-js/sdk` as the client (a dev dependency only): fetch the card, send, block, stream, resubscribe, get, list, cancel, and a push config against a local receiver. It then runs the SDK's sample server and has our client call it through a connection. If the SDK's current release doesn't speak 1.0, say so in the review file, pin the nearest version it supports for the parts that still apply, and rely on the TCK below.
- Run the official TCK from https://github.com/a2aproject/a2a-tck against a local server on both bindings. Keep the results in `docs/reviews/tasks/AA.8.md`. Fix every failure in a mandatory category. Any left open get a line each saying why they're left, for Dom to decide.
- `scripts/e2e/a2a-two-deployments.ts`: two `vite dev` servers on different ports with separate `.wrangler` state, so two databases and real HTTP between them. Allow plain HTTP to localhost in dev only, and add a test that a production build refuses it. Drive pairing through the services' routes, then a message each way, including the approve path and a wake, then revoke on one side and confirm that both sides stop.
- Fix what these find. A fix in another task's area is in scope here.
- Docs: a `packages/a2a/README.md`, a `packages/services/src/a2a/README.md`, a CLAUDE.md section "Agent connections" with the rules that are easy to break (tokens work only on `/a2a`, no MCP tool may change a connection, peer text is outside input), and the outcomes in `docs/v3/agent-connections.md` where the build changed them.
- Use the `unslop` skill on the docs.

## Check
- Both scripts exit 0, run from the repo root, and the review file holds their output summary and the TCK results.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-31: created.
