---
id: KY.10
title: "What a plain member can do on the Keys tab"
milestone: KY
size: S
status: in_progress
depends_on: [KY.7]
branch: task/KY.10-what-a-plain-member-can-do-on-the-keys-t
lane: web-keys
executor: claude
---

From the KY walkthrough (`docs/reviews/KY-e2e.md`).

A plain member sees the whole Slack connect form for the agent's identity, the "Passwords and keys" panel with the workspace secret list and grant switch, Remove, Allowed tools and the sign-in mode select. Round 2 showed the server accepts a plain member changing the "Whose sign-in it uses" select. The rest were not pressed, so what else the server refuses is not known. KY.8 closed only the app credential.

## Decision

Decision (controller, under Dom's "don't wait for me", 20 Nov 2026): only the agent's owners and workspace admins may change its apps, allowed tools, sign-in mode, Slack app and secret grants, matching KY.8. Everyone else sees the controls disabled, and the secrets panel only if allowed.

## Scope

- The services refuse a plain member (not an owner of the agent, not an admin) on connector assign, sign-in mode, allowed tools, remove, Slack app create and secret grant for that agent.
- The Keys tab disables those controls for such a member and shows the secrets panel only to people allowed to manage it.

## Check

Service tests for owner, admin and member on assign, mode, allowed tools, remove, Slack app create and secret grant. Browser as the member: the controls are disabled or hidden.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the KY walkthrough.
- 2026-11-20: dispatched on task/KY.10-what-a-plain-member-can-do-on-the-keys-t (v4 controller session).
