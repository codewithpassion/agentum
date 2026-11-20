---
id: KY.5
title: "Keys tab on the agent room"
milestone: KY
size: M
status: done
depends_on: [KY.1, RH.4]
branch: task/KY.5-keys-tab
lane: web-keys
executor: claude
---

From `docs/v4/build-plan.md`, milestone KY. The Keys tab replaces the tools sheet, channels sheet and ask-before card with one page. Mockup: section "Proposal A" and the concept table in the report.

## Scope

- Build in `components/agent/room/keys/` from `keys.forAgent`. Five sections: Apps it can use, Its own identity (email, Slack), Passwords and keys, Other agents, Asks before.
- Apps: each row says whose sign-in it uses in words ("the person asking, or its own"). Actions: add from catalogue, change sign-in mode, allowed tools, remove. Reuse the forms from `profile/sheets/` and `components/connectors/`.
- "Connect my account" on a row for the signed-in person, using `connectors.mine`.
- Asks before: `ask-before-card.tsx` moves here unchanged.

- When the tab assigns a catalogue connector to the agent, it sets `allowed_tools` from the catalogue entry's `defaultAllowedTools`, looked up by `catalog_key` (from KY.4). Otherwise a catalogue app like Gmail gets every tool.

## Check

- Component tests for each section with a fixture.
- Browser: add an app from the catalogue, assign it, connect your own account as a non-admin.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: note from KY.2 review: an app with `authKind: "none"` returns `signIn: null`. Do not read that as "sign in needed".
- 2026-11-20: dispatched on task/KY.5-keys-tab (v4 controller session).
- 2026-11-20: scope adds the catalogue default allowed tools, from the KY.4 review. A catalogue connector without them would get every tool.
- 2026-11-20: merged as 7c4a7bb9, review clean after 1 fix round. Browser proof passed at both sizes: docs/reviews/tasks/KY.5/browser.md. check and build passed on main; tests passed except guest-execution.test.ts, which failed the same way on main before this merge (FX.1). Dom: after deploy, connect one catalogue app on staging as a member from the Keys tab (needs a real vendor account).
