# KY.4 review: app catalogue

## Verdict

Round 1 (fbef5162, Opus medium): clean, nothing must-fix in the branch. Clean after 0 fix rounds.

## What was built

`packages/services/src/catalog/entries.ts` holds five entries: Gmail, Linear, Notion, Slack and Cloudflare Docs, each with its vendor documentation URL in the comment above it and a non-empty list of read-only default tools. `catalog.add` needs an admin session, returns the existing connector for a second add of the same key in a workspace, and otherwise inserts a connector row straight from the entry with no network call. It forces `authMode` to the entry's auth kind, stores `catalog_key`, leaves `oauth` null (discovery runs lazily at connect time), and sets status `needs_auth` for OAuth and header entries. `catalog.list()` returns the entries with their default allow-lists.

## Reading of "default tool allow-list"

A connector has no allow-list column. The list is per assignment (`agent_connectors.allowed_tools`). So the default stays on the entry and `catalog.list()` returns it. Nothing applies it yet.

## Nits left

- Two adds at the same moment can create two rows, since there is no unique `(workspace_id, catalog_key)` index. Fixing it needs a migration. The code says so in a comment.
- Linear also documents a read-only endpoint, `https://mcp.linear.app/mcp/readonly`. The entry uses the read-write one and relies on the allow-list.
- The Linear tool names have no cited source, and Slack's come from a Slack plugin command file because Slack publishes no tool reference.
- `entries.test.ts` hard-codes vendor prefixes in its read-only tool regex, so a new vendor needs a regex change.
- A `none` entry stores `authMode: "none"` where a URL-added connector would store `auto`. Intended.

## Ideas beyond scope

- A partial unique index on `(workspace_id, catalog_key) WHERE catalog_key IS NOT NULL`.
- More entries (Sentry, Atlassian, Asana, Stripe, GitHub) once their endpoints and tool names are verified.

## For the controller

KY.5 must set `allowed_tools` from the entry's `defaultAllowedTools`, found by `catalog_key`, when it assigns a catalogue connector. An assignment with `allowed_tools = null` allows every tool, so a catalogue Gmail would get the write tools otherwise. `docs/tasks/KY.5-keys-tab.md` does not say this yet.

## Steps for Dom

None.

## Checks

`bun run check` and `bun run build` pass. `bun run test` passes except `apps/web` `guest-execution.test.ts`, which fails on this host on main too.
