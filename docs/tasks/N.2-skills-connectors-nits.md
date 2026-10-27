---
id: N.2
title: Review nits in skill and connector delete (SK.5)
milestone: N
size: S
status: todo
depends_on: []
branch: null
lane: skills
executor: claude
---

Dom asked on 27 Oct 2026 to clear the nits the SK.5 review left (`docs/reviews/tasks/SK.5.md`).

## Scope

- Skill delete: R2 blob removal after the DB delete is best-effort (logged, not an error for a delete that happened); close the commit-versus-delete race on a shared blob, or document why it can't lose data; remove the skill's `managed_skill_versions` rows and its Anthropic-side skills; make the live-run check and the delete one step where the platform allows.
- Connector delete: refuse while a live run uses the connector, or say in the dialog what happens to running agents; `delete_connector` called with a key writes the same `admin.action` audit event as the other admin tools; the dialog uses the shared `errorMessage`.
- Tests: the connector remove test seeds an `oauth_states` row and checks it is gone.

## Check

- Tests for each item. `bun run check && bun run test && bun run build` pass.
- On staging (controller): delete the two pending-only `p5-loop` skills owned by `p5-glm53` and `p5-glm53-flash` in the Dev Workspace.

## Log
- 2026-10-27: added at Dom's request (clear review nits).
