# KY.8 review

## Verdict

Round 1, commit 97916502: clean after 0 fix rounds. Four nits, none must-fix.

## What changed

- `requireAgentOwnerOrAdmin` in `guards.ts`: an org admin, or the agent's owner (`ownerUserId`, falling back to `createdBy`), passes. Anyone else gets `ForbiddenError`.
- `connectors.setCredential` with an `agentId` and `connectorOAuth.start` as `agent:<id>` apply it after the agent is loaded. `complete` applies it again before the credential is written, because the owner can change between start and callback.
- The Keys tab hides "Paste as this agent" and "Connect / Reconnect as this agent" from people the rule refuses (`canSetAgentCredential` in `keys-logic.ts`). A person's own sign-in controls are unchanged.
- Tests: owner, admin and plain member for `setCredential` and OAuth start; an owner who lost the agent before the callback; a member still sets their own credential. The concurrency test in `connectors.test.ts` now uses an admin as its second caller.

## Nits left

- `guards.ts`: `requireAgentOwnerOrAdmin` duplicates `requireAdminOrOwner` in `a2a/access.ts` and `assertOwnerOrAdmin` in `agents.ts`. Fold them together in a cleanup.
- `keys-logic.ts`: `canSetAgentCredential` repeats `ownerUserId ?? createdBy`; `ownerIdOf` in `profile/asks-logic.ts` does the same.
- `connector-oauth.ts` (`store`): when the rule refuses at `complete`, the person gets the route's bare "Not allowed." 403, not a redirect back to the Keys tab with a reason. Nothing is stored.
- `connectors.test.ts`: one comment calls the third refusal "a plain member"; it is a non-owner of that agent.

## Beyond the scope

- An agent's backup owner is not treated as an owner here, matching `effectiveOwner` everywhere else.
- `removeCredential` on an agent credential is unchanged.

## Test notes

- `@repo/services` `runs.test.ts` "an hour of never-claimed runs stays bounded" timed out at 60 s inside the full parallel run and passed alone (174 pass, 51 s).
- The Rust test `the_session_bus_listens_where_the_environment_says` fails in long worktree paths (D-Bus socket path length). KY.8 changes no Rust.

## Steps for Dom

None.
