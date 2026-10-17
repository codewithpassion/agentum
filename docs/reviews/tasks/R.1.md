# R.1 review

## Verdicts

- Round 1 (5733a99): not clean. Two must-fix findings, both in the trigger table. A proposal that was rejected or deleted still showed "awaiting approval" with Approve and Reject, and nothing in the UI could resume a paused trigger.
- Round 2 (ea2427b, the fix commit only): clean, no must-fix, four nits. The coordinator relayed the verdict; the four nits are not itemised here.

The browser check passed on a local dev server with dev login. A proposed routine showed "Proposed by Browser Bot" with Approve and Reject, and Approve enabled it with a next run. A proposed trigger showed the same, and Approve opened the secret dialog once.

## Decisions

- A run may switch its own agent's routines and triggers off, never on. `set_*_enabled(true)` from a run is always forbidden, its own proposals included.
- A run deletes only items whose `proposed_by_agent_id` is its agent, in any state, so a later run can retract an earlier run's proposal.
- A proposed HTTP trigger has no token. Approval mints it and returns the secret once to the person approving, so the run never holds one.
- `setEnabled(true)` by a person on a pending proposal counts as approval, so MCP users have no dead end.
- A read-only API key or connected app gets only the list tools for routines and triggers. The tools are filtered at registration and the services refuse writes too. The existing tools are unchanged.
- Four event types, `trigger.created`, `trigger.approved`, `trigger.rejected` and `trigger.deleted`, with the principal named in the payload (agent for a run, user with `via` and key or client id otherwise). Plain pauses and resumes write none.
- `created_by` holds the run id for a run's proposal. `proposed_by_agent_id`, `proposed_by_run_id` and `approved_at` are new nullable columns, so the migration is three `ADD COLUMN` lines.
- A paused HTTP trigger cannot authenticate (401) or fire.

## Nits left

- Create and approve write the row and its event in two statements, not through `atomic`. `agents.ts` and `api-keys.ts` do the same.
- A run pausing a person's routine or trigger leaves no event.
- The pause and resume update has no `revoked_at` guard. A remove landing between the read and the write touches a revoked row, which never fires.
- The delete tools are marked idempotent, but a repeated `delete_routine` returns not_found while a repeated `delete_trigger` succeeds.
- `isReadOnly` repeats the check in `library.ts`, `inbox.ts` and `runs/subject.ts`, and `routes/mcp.ts` imports it from the automation module.

## Ideas beyond the scope

- A person's OAuth client such as Claude.ai can approve a proposal by calling `set_*_enabled(true)`, and approving a trigger returns the secret in that result. That follows "same rules as the UI", but a prompt injection in that client could approve a proposal. Decide whether approval should be UI only, and if so make the service require a session for `approve`.
- Add a log filter and labels for the four new event types in the event log UI.

## Steps for Dom

None. No account, dashboard or remote step. The migration `0004_cooing_shadowcat.sql` applies with the usual `wrangler d1 migrations apply DB --remote` at deploy.
