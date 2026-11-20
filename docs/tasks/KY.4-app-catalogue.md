---
id: KY.4
title: "App catalogue: connect an app without a URL"
milestone: KY
size: M
status: done
depends_on: [KY.1]
branch: task/KY.4-app-catalogue
lane: services-catalog
executor: codex
---

From `docs/v4/build-plan.md`, milestone KY. A connector is a name, a URL and an auth mode. A catalogue lets a person pick an app by name.

## Scope

- `packages/services/src/catalog/entries.ts`: a typed list. Start with the connectors already used in the Harbour Edge workspace and add only apps whose vendor documents a remote MCP endpoint. Record the documentation URL in a comment per entry. Ten entries at most.
- `catalog.add` creates a connector from an entry with its default tool allow-list and sets `catalog_key`. A second add of the same key returns the existing connector.
- No network calls in tests.

## Check

- Tests: add, idempotent add, a non-admin is refused.
- A test asserts every entry has an https URL and a documentation comment.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/KY.4-app-catalogue (v4 controller session).
- 2026-11-20: merged as 4df93e82, review clean after 0 fix rounds. check and build passed on main. bun run test passed except guest-execution.test.ts, which passed when run alone on the merged tree.
