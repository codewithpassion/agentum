---
id: C.0
title: Spike - Pi Durable agents on Cloudflare
milestone: C
size: M
status: done
depends_on: [O.1]
branch: null
---

Asked for by Dom on 17 Oct 2026: agents that run on Cloudflare instead of an enrolled machine, using Pi Durable. Cloudflare's Agents SDK v0.26.0 runs the Pi Durable harness inside a Durable Object as `PiHarness` (beta). Pi Durable itself (`@earendil-works/pi-durable`) is experimental. Docs: https://developers.cloudflare.com/agents/harnesses/pi/ and the changelog https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness/. Earlier study of a Node-only Pi Durable demo: `docs/analysis/durable-pi.md`. The source is at `/home/roboto/devel/durable-pi`, read-only.

This is a spike. The prototype lives in `/home/roboto/devel/harbourmaster-wt/tmp/spike-pi-durable/`, not in the repo, like the just-bash spike (`docs/reviews/spike-just-bash.md`). The deliverable is a report.

## Questions to answer

1. Does `PiHarness` run in a Durable Object under `wrangler dev`, and in the same Worker as Harbourmaster (bundle size added, compatibility flags, `nodejs_compat`, and conflicts with our Vite and TanStack Start build)? Or does it need its own Worker reached by a service binding?
2. Can one Pi agent handle one Harbourmaster run end to end: take the run's input (prompt, thread context, attachments), stream its reply and events back into our run lifecycle, and finish or fail the run the way a machine run does? Sketch the `CloudRuntime` adapter next to the existing machine runtime and the planned `ManagedRuntime` (M8.1).
3. Tools: can the Pi agent call Harbourmaster's own MCP server (library `bash`, connectors through `/api/proxy`) with a run token? Which Pi built-in tools (file edit, shell) work without a container, and what needs Cloudflare Sandbox or Containers?
4. Durability: survive a DO eviction or restart mid-turn (kill `wrangler dev` and restart) and resume. Note the side-effect warning (tools may run twice after recovery).
5. Models: Anthropic through `@earendil-works/pi-ai` with a workspace key. Use the faux provider wherever no key is needed. Live model calls only if `ANTHROPIC_API_KEY` is in `apps/web/.env.local`. Never print or log the key.
6. Skills and files: can workspace skills (S.1) and the library (F.*) be given to a Pi agent?
7. Cost and limits: DO CPU time and duration per turn, storage, alarms, and how this compares with Managed Agents.

## Deliverable

`docs/reviews/spike-pi-durable.md`: go or no-go, answers to each question with evidence (commands run, results), the prototype's location, a proposed task list (ids, sizes, checks) for a real Cloudflare runtime if it's a go, and steps for Dom. Commit only the report, on a branch `task/C.0-pi-durable-spike`. The controller merges it.

## Log
- 2026-10-17: added at Dom's request; dispatched.
- 2026-10-17: report at b970264 (docs/reviews/spike-pi-durable.md): conditional go. PiHarness ran in the Harbourmaster Worker (+1.7 MiB), finished a run via /mcp, /api/proxy and skills, resumed after kill -9. Live Anthropic not run (no key). Waits for Dom's go/no-go.
