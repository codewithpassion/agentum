---
id: P.2
title: Settings page for model providers
milestone: P
size: S
status: todo
depends_on: [P.1]
branch: task/P.2-model-providers-settings
---

Asked for by Dom on 19 Oct 2026, from the report `docs/analysis/other-model-providers.md` (section D). People need a place to paste a workspace's OpenRouter key. Follow the existing "Anthropic API key" Settings section for the paste, hint and remove flow.

## Scope

- Add a tRPC router in `apps/web/src/server/trpc/` with `status`, `set` and `remove` for the OpenRouter key. It stays thin and calls `@repo/services/model-keys`.
- Add a "Model providers" Settings page next to "Anthropic API key". It shows the key hint, takes a pasted key, and removes it.
- No key appears in a response, a log line or the client bundle. Only the hint (last four characters) comes back.

## Check

- A router test covers `set`, `status` and `remove`, and that a response never holds the key.
- In the browser with dev login: add a key, see its hint, remove it. No key appears in network responses or logs.
- `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` in `apps/web/dist/client` passes.

## Log
- 2026-10-19: added at Dom's request.
