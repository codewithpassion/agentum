---
id: ME.16
title: "The outside-text guard covers every web path"
milestone: ME
size: M
status: todo
depends_on: []
branch: null
lane: services-memory
executor: claude
---

From the ME gate review, round 1 (`docs/reviews/ME-1.md`, MF-3). Private notes stay with their person (Dom, 19 Nov 2026).

## Decision

Controller decision (20 Nov 2026): if a machine agent's raw shell web use can't be detected, hold every agent note from a run that had shell access and write that limit in docs/v4/memory-format.md. Safer to hold than to apply text from outside unseen.

## Scope

`usedWeb` in `memory/provenance.ts` counts any `network.request` the run made, whatever its `via`, plus `browser.action`, plus the tool events for web tools on the machine and managed runtimes (Claude Code's WebFetch and WebSearch, Managed Agents' `web_fetch` and `web_search`). Find the event types and names those runtimes record, and add them. If a path cannot be detected at all, such as a raw `curl` in a machine agent's shell, write that limit down in `docs/v4/memory-format.md` and hold every agent note from that runtime when the run had shell access, or record the decision not to.

## Check

Service tests: a `remember` from a run whose only web use is a cloud `curl`, a cloud `run_script` fetch, a machine WebFetch tool call and a managed `web_fetch` call is held under "Tell me after" and "Quietly". A run with no web use still applies at once. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the ME gate review, round 1.
