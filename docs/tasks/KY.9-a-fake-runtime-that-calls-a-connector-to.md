---
id: KY.9
title: "A fake runtime that calls a connector tool"
milestone: KY
size: S
status: in_progress
depends_on: [KY.7]
branch: task/KY.9-a-fake-runtime-that-calls-a-connector-to
lane: services-runs
executor: claude
---

From the KY walkthrough (`docs/reviews/KY-e2e.md`).

The walkthrough's last step has no way to run. The fake runtime echoes. The proxy accepts a call only with a run token for a running run, so a person cannot see an agent use a tool without hand-minting tokens.

## Scope

A second fake mode, chosen by the task text or the agent's model name (for example `fake-tool`), that after claiming the run reads the agent's assigned connectors, calls `tools/list` and one allowed `tools/call` through its own `/api/proxy` path with a real run token, and writes the result as run events and as the reply ("Used search_cloudflare_documentation: ..."). If the tool needs a sign-in the person asking lacks, the reply carries the connect link from the proxy error. The mode is registered only when `devFakeRuntime` is true, as the echo runtime is. It needs the proxy's base URL, so decide how `createRunsService` learns it (a new dep, not `env`).

## Check

A `runs` test with a stubbed proxy fetch: a run with a signed-in person calls the tool, a run with none gets the connect link, a tool outside the allow-list is refused. Browser: add Cloudflare Docs to Fake echo, press Run now, read the tool result in the task.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the KY walkthrough.
- 2026-11-20: dispatched on task/KY.9-a-fake-runtime-that-calls-a-connector-to (v4 controller session).
