---
id: FR.6
title: "Team starters in the New team dialog"
milestone: FR
size: S
status: in_progress
depends_on: []
branch: null
lane: web-team
executor: claude
---

From the FR.5 walkthrough (`docs/reviews/FR-e2e.md`, must-fix). FR.2 shipped `builder.teamFromStarter` and the two starters (Sales, Back office) on the server only. FR.4 promised that "team starters appear in the New team dialog when FR.2 has shipped", and they don't. The walkthrough could create a team from a starter only by calling tRPC by hand, and only after setting a runtime on every member by hand.

## Scope

- The New team dialog offers the two team starters next to the blank team. Picking one shows the draft from `teamFromStarter` (team name, lead, members, rules) for review, and Create makes it in one call.
- Members get a runtime without per-member setup: use the workspace's default runtime, the same one a new agent from a template gets. If none exists, the dialog says so and links to the key step, as agent Create does.
- No other change to the dialog.

## Check

- Component tests: the dialog lists both starters, and confirming one calls the create path with the starter key.
- A service or router test: a team from a starter gets a runtime on every member.
- `bun run check` and `bunx turbo run test build --only --filter="[origin/main...HEAD]"` pass.

## Log
- 2026-11-21: added by controller from the FR.5 walkthrough.
- 2026-11-21: dispatched.
