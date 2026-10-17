---
id: U.7
title: Label the workspace Anthropic key for every agent kind
milestone: U
size: S
status: in_progress
depends_on: [C.13]
branch: task/U.7-anthropic-key-label
---

Asked for by Dom on 17 Oct 2026. Cloudflare agents and Managed Agents both read the workspace's Anthropic API key, but it is set under Settings → Managed Agents, and the missing-key errors (`packages/services/src/managed/service.ts`, `apps/web/src/server/pi-run-credentials.ts`) point there. Dom's Cloudflare agent failed with that error and the place to fix it was not obvious.

## Scope

- In the settings page (`apps/web/src/routes/_app/settings.managed-agents.tsx`) and the settings navigation, give the key its own clearly named section, "Anthropic API key", saying it is used by Cloudflare agents and Managed Agents. Keep the route path, so links and bookmarks work; the nav label may change to "Anthropic" or similar. Other Managed Agents settings on that page stay where they are.
- One shared missing-key message for both runtimes, naming where to add it with the new label, for example "This workspace has no Anthropic API key. Add one in Settings, Anthropic API key." Define it once and use it from both places.
- Update tests that assert the old text.

## Check

- Tests pass with the new message, from both the managed and the Cloudflare path.
- Browser, with dev login on a local dev server: the settings page shows the "Anthropic API key" section and says which agents use it.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added at Dom's request; dispatched on task/U.7-anthropic-key-label.
