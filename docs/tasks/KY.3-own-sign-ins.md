---
id: KY.3
title: "Members manage their own sign-ins"
milestone: KY
size: S
status: done
depends_on: [KY.1]
branch: task/KY.3-own-sign-ins
lane: services-connectors
executor: codex
---

From `docs/v4/build-plan.md`, milestone KY. "Your credential" lives in Settings, which only admins can open. Every member needs to connect and disconnect their own sign-in.

## Scope

- In `packages/services/src/connectors.ts`, `credentials.ts` and `connector-oauth.ts`: listing connectors and starting, finishing or removing the caller's own credential needs membership, not admin.
- Creating, editing or deleting a connector stays admin only. Expose `connectors.mine` in `connectors-router.ts` (the router file already exists, so no root change).

## Check

- Authz tests: a member connects and disconnects their own credential, cannot touch another person's or the connector itself.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/KY.3-own-sign-ins (v4 controller session).
- 2026-11-20: merged as 019a0237, review clean after 0 fix rounds (the reviewer's must-fix on agent credentials was out of scope and became KY.8). check, test and build passed on main. Connector create, edit and delete now need an admin in the service, not just the Settings UI.
