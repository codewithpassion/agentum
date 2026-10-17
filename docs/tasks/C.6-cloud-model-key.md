---
id: C.6
title: Workspace model key for cloud agents
milestone: C
size: M
status: done
depends_on: [C.4, M8.1]
branch: task/C.6-cloud-model-key
---

From the C.0 spike (`docs/reviews/spike-pi-durable.md`, "Proposed tasks" and the findings above it). Dom said go on all Cloudflare agent tasks on 17 Oct 2026. Read the spike report first. The prototype is in `/home/roboto/devel/harbourmaster-wt/tmp/spike-pi-durable/`, read-only, and code can be lifted from it.

## Scope

Read the decrypted Anthropic key per run from the workspace secrets store that M8.1 adds, pass it through a `CredentialStore`, and keep it out of Durable Object storage. Add a model list for cloud agents. Never print or log the key.

## Check

A test with a fake Messages server asserts `x-api-key`. Live, with `ANTHROPIC_API_KEY` from `apps/web/.env.local` stored as the workspace key: a cloud agent answers "Reply with the word pelican" on a local dev server. `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` passes.

## Log
- 2026-10-17: added from the C.0 spike (Dom: go on all).
- 2026-10-17: dispatched on task/C.6-cloud-model-key.
- 2026-10-17: review clean after 0 fix rounds at 5d7e665 (docs/reviews/tasks/C.6.md). Merged. Live pelican passed locally with the workspace key. Nit: unknown model id fails with Pi's bare no_model.
