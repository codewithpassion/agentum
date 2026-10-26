---
id: X.4
title: Agent Task sign-in lands with an active organisation on the production instance
milestone: X
size: S
status: todo
depends_on: [X.1]
branch: null
lane: web
executor: claude
---

Found in X.1's production sign-in check on 26 Oct 2026 (`harbourmaster-wt/tmp/X.1/prod-signin.md`). On the shared production Clerk instance, a session from `bun run agent-login` lands with status `pending` and the session task `choose-organization`, so no organisation is active and the app shows the signed-out header. The check only got in by calling `window.Clerk.setActive` by hand. On the dev instance Clerk activated the org itself, which is what CLAUDE.md "Agent Task login" promises. Every agent and browser check on staging and production, V1.15 included, needs this to work.

## Scope

- Make an Agent Task sign-in land on the signed-in pages with an allowed organisation active, on the production instance, with no manual step. Find the cause first (instance setting such as "require organization" / session tasks, or something the app should handle), and prefer an app-side fix that works on both instances, for example handling Clerk's `choose-organization` session task by activating the user's only allowed organisation, or making the redirect target do it.
- If the only fix is a Clerk dashboard setting, write the exact setting for Dom in the review file and change no code.
- Update CLAUDE.md "Agent Task login" to match.

## Check

- Unit tests for any helper that picks the organisation.
- On staging (controller, after merge): `bun run agent-login --env staging --email dev@rockyshoreslabs.io` opened in a fresh browser lands on `/` signed in with Dev Workspace active, with no manual step.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-26: added from X.1's production sign-in check.
