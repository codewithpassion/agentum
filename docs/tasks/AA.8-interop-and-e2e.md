---
id: AA.8
title: "Interop with the official A2A SDK and TCK, two-deployment end to end, docs"
milestone: AA
size: M
status: todo
depends_on: [AA.4, AA.5, AA.6, AA.7, AA.9]
branch: null
lane: ops
executor: claude
---

Spec: `docs/v3/agent-connections.md`. This task proves the claim that we speak A2A, using code we didn't write.

## Scope
- `scripts/e2e/a2a-interop.ts`: starts a local server and drives it with `@a2a-js/sdk` as the client (a dev dependency only): fetch the card, send, block, stream, resubscribe, get, list, cancel, and a push config against a local receiver. It then runs the SDK's sample server and has our client call it through a connection. If the SDK's current release doesn't speak 1.0, say so in the review file, pin the nearest version it supports for the parts that still apply, and rely on the TCK below.
- Run the official TCK from https://github.com/a2aproject/a2a-tck against a local server on both bindings. Keep the results in `docs/reviews/tasks/AA.8.md`. Fix every failure in a mandatory category. Any left open get a line each saying why they're left, for Dom to decide.
- `scripts/e2e/a2a-hermes.ts`: interop with a real Hermes at the latest release tag, checked out and installed in its own directory under `/home/roboto/devel/harbourmaster-wt/tmp/AA.8/`, never inside the repo. Run its gateway with the `a2a` platform on, pointed at a local fake OpenAI-compatible model endpoint so no key or spend is needed. Both directions:
  - Hermes's `a2a_discover` and `a2a_call` reach our published agent with a key. Test `auto` (the answer comes back) and `approve` (the waiting message comes back).
  - Pairing: with "Accept pairing requests" on, Hermes's first `a2a_call` with a made-up token returns the code as its reply. Entering the code on our side lets the next call through.
  - Our client calls Hermes through a "Call it" connection. Confirm a reply that outlasts our client timeout is still recovered through `ListTasks` and `GetTask`, and a push nudge leads to the full text past 2000 characters.
  - If the gateway can't be run this way, drive its `adapter.py` and `tools.py` directly with the agent stubbed, and say so in the review file.
- `scripts/e2e/a2a-two-deployments.ts`: two `vite dev` servers on different ports with separate `.wrangler` state, so two databases and real HTTP between them. Allow plain HTTP to localhost in dev only, and add a test that a production build refuses it. Drive pairing through the services' routes, then a message each way, including the approve path and a wake, then revoke on one side and confirm that both sides stop.
- Fix what these find. A fix in another task's area is in scope here.
- Docs: a `packages/a2a/README.md`, a `packages/services/src/a2a/README.md`, a CLAUDE.md section "Agent connections" with the rules that are easy to break (tokens work only on `/a2a`, no MCP tool may change a connection, peer text is outside input), and the outcomes in `docs/v3/agent-connections.md` where the build changed them.
- Use the `unslop` skill on the docs.

## Check
- All three scripts exit 0, run from the repo root, and the review file holds their output summary and the TCK results.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-31: created.
- 2026-11-01: from AA.7: redo invite, join, approve, the `/a2a` send and "Call it" over real HTTP here. Delete the scratch Clerk user `aa7-second-workspace@example.com` and org "AA7 Second Workspace" from the dev instance if you can, otherwise list them for Dom.
