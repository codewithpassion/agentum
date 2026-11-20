---
id: KY.5
title: "Keys tab on the agent room"
milestone: KY
size: M
status: todo
depends_on: [KY.1, RH.4]
branch: null
lane: web-keys
executor: claude
---

From `docs/v4/build-plan.md`, milestone KY. The Keys tab replaces the tools sheet, channels sheet and ask-before card with one page. Mockup: section "Proposal A" and the concept table in the report.

## Scope

- Build in `components/agent/room/keys/` from `keys.forAgent`. Five sections: Apps it can use, Its own identity (email, Slack), Passwords and keys, Other agents, Asks before.
- Apps: each row says whose sign-in it uses in words ("the person asking, or its own"). Actions: add from catalogue, change sign-in mode, allowed tools, remove. Reuse the forms from `profile/sheets/` and `components/connectors/`.
- "Connect my account" on a row for the signed-in person, using `connectors.mine`.
- Asks before: `ask-before-card.tsx` moves here unchanged.

## Check

- Component tests for each section with a fixture.
- Browser: add an app from the catalogue, assign it, connect your own account as a non-admin.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: note from KY.2 review: an app with `authKind: "none"` returns `signIn: null`. Do not read that as "sign in needed".
