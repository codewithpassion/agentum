# N.1 review: nits in the desk and admin API

## Verdicts

Round 1 (8757631): clean, no must-fix. Check, test, build and the client bundle grep pass.

## What changed

- Desk run `error` is cut to 300 characters. `readRun` no longer checks visibility twice, and a run id over 200 characters answers 404. Tests cover `offered`, `waiting` and `cancelled`.
- `unassign` needs a session, so a write key cannot unassign connectors.
- `update_agent` refuses an archived agent before saving. Runtime settings go in as a patch on `agents.update`, which fails with a conflict when the config changed since it was read.
- Invalid secret names give the real message over MCP (`guarded.ts` turns a `ZodError` into a validation error). The UI already got it through the tRPC error formatter, and a test now pins that.
- The key dialog says write keys can send messages and create or change agents.
- Tests: connector credential mode kept on a repeat update, `build-context.ts` passing `orgRole`, `assign_skill` through the MCP route writing its audit event.

## Nits left

- A config patch on a deleted agent answers conflict, not not_found (`agents.ts`).
- The concurrency guard compares stored text with compact `JSON.stringify`; a hand-written row would always conflict.
- `update` now parses input after the agent lookup, so an invalid update to an unknown agent answers not found.
- The 300 character cut counts UTF-16 units and can split a surrogate pair.
- `guarded` maps any `ZodError`, including one from corrupt stored rows, to a validation error, and shows only the first issue without its field path.
- The key dialog text omits inbox threads, skills and connectors for write keys.

## Ideas beyond the scope

- Include the field path in the validation message `guarded` returns.

## Steps for Dom

None.
