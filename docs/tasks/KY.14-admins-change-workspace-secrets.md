---
id: KY.14
title: "Only admins change or delete a workspace secret"
milestone: KY
size: S
status: done
depends_on: []
branch: task/KY.14-admins-change-workspace-secrets
lane: services-secrets
executor: claude
---

From the KY gate review, round 1 (`docs/reviews/KY-1.md`).

## Decision

Controller decision (Dom's "don't wait for me", 20 Nov 2026): take the default. Creating, editing and deleting workspace secrets is for admins only, matching connectors since KY.3. Per-agent grants stay with owners and admins.

## Scope

- `secrets.update` and `secrets.remove` refuse anyone who is not an org admin on a session or an admin key, matching connector edit and delete since KY.3. Default to making `secrets.create` admin-only as well, so `/settings/secrets` is the admin page KY.6 describes.
- A narrower alternative, if Dom wants members to keep managing secrets: refuse `update` and `remove` when the secret is granted to an agent the caller is not an owner of, using `requireAgentOwnerOrAdmin` for each granted agent.
- Leave the per-agent `grant`, `revoke` and `setGrants` rule as it is (owner or admin).
- `/settings/secrets` hides or disables New secret, Replace, Rules, Hosts and Delete for people the service refuses, and says why.
- Update the existing secrets test that lets a member edit hosts.

## Check

- Service tests for owner-not-admin, admin, admin key and plain member on update (value, hosts, rules) and remove. A refused remove leaves every agent's grants and the connector rows unchanged.
- Browser as a plain member on `/settings/secrets`: the write controls are disabled or hidden. As admin, they work.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the KY gate review, round 1.
- 2026-11-20: dispatched on task/KY.14-admins-change-workspace-secrets (v4 controller session).
- 2026-11-20: merged as 9f68f728, review clean after 0 fix rounds. Browser proof passed: docs/reviews/tasks/KY.14/browser.md. check, test and build passed on main.
