---
id: KY.6
title: "Settings: your sign-ins for everyone"
milestone: KY
size: S
status: todo
depends_on: [KY.3]
branch: null
lane: web-settings
executor: claude
---

From `docs/v4/build-plan.md`, milestone KY. The workspace registry stays for admins. Every member gets a page for their own sign-ins.

## Scope

- New page "Your sign-ins" reachable from the user menu and Find for all members, listing connectors with connect and disconnect, from `connectors.mine`.
- `/settings/connectors` and `/settings/secrets` stay admin pages, renamed in the nav to "Apps" and "Passwords and keys".
- Add the page to `find-registry.ts` and `components/settings/settings-nav.ts`.

## Check

- Browser as a non-admin: the page opens and a sign-in can be added and removed.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
