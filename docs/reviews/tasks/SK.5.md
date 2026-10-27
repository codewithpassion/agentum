# SK.5 review

## Scope check against main (27 Oct)

Checked each item against main before building. None was already done: no delete existed for skills or connectors (UI, tRPC or MCP), agent-created skills were not assigned to their owner, and Log summaries showed only the skill name. All four items were built.

## Verdicts

Round 1 at 6c14cf3: clean, no must-fix. Also browser-checked by the dispatcher: a skill and a connector were deleted from the UI on a local dev server.

## Nits left

- Blob removal runs after the DB delete and is not best-effort, so an R2 failure shows an error for a delete that happened (skills-store.ts `remove`).
- A commit racing a delete can lose a shared blob in a narrow window.
- `managed_skill_versions` rows (and the Anthropic-side skills) for a deleted skill are left behind.
- The live-run check and the delete are not one atomic step.
- `delete_connector` calls the connectors service directly, so it writes no `api_key` audit event beyond `connector.deleted`.
- The connector remove test does not seed an `oauth_states` row.
- Connector delete does not check for live runs, and its dialog does not say what happens to running agents.
- The connector dialog has its own `errorMessage` where the skill dialog imports the shared one.

## Ideas beyond scope

- An MCP tool to list connectors, so `delete_connector` needs no id from the UI.
- Clean up `managed_skill_versions` on skill delete.

## Steps for Dom

None. The controller deletes `sk-check`, `sk-agent`, `p5-loop` and `p5-stub` on staging after deploy: skills in the Skills page (Delete button on the skill), `p5-stub` in Settings, Connectors. Connector delete over MCP needs an admin API key.
