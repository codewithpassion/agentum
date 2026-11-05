---
id: WA.2
title: Workspace assistant, the page
milestone: WA
size: M
status: in_progress
depends_on: [WA.1]
branch: WA-workspace-assistant
lane: web
executor: codex
---

Spec: `docs/v3/workspace-assistant.md` ("What it is", "The secret card", "Confirm before destructive tools", "Keeping keys out of the chat").

## Scope
- `/assistant` route, rail entry and `rail/find-registry.ts` entry.
- Conversation list (desktop side list, phone back button), new conversation, archive.
- The message list: person and assistant messages, tool calls as collapsible lines, the working line, errors.
- The secret card and model key card: the browser calls `secrets.create` / `secrets.setGrants` / the model keys mutation itself, then `assistant.resolveCard` with the outcome only. Masking and password manager attributes as the spec says.
- The confirm card for destructive tools.
- The "That looks like a key" refusal shows with an Add secret button that opens the card without the model.
- Reuse the app's existing chat pieces (composer, message styles) where they fit, rather than new ones.

## Check
- Tests:
  - The card never sends the value to an `assistant.*` procedure (assert on the calls).
  - The value input has the masking style and the ignore attributes.
  - The card's states: open, saving, error kept open, saved line, declined line.
  - The confirm card sends run and don't-run.
  - `find-registry.test.ts` passes with the new page.
- `bun run check && bun run test && bun run build`, then the bundle grep for `drizzle` in `apps/web/dist/client`.
- Screenshots of a dev build at 1280x900 and 390x844: empty page, a conversation with tool lines, an open secret card, a confirm card. Save them in `/home/roboto/devel/harbourmaster-wt/tmp/WA/`.

## Log
