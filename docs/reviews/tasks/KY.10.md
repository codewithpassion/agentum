# KY.10 review

## Verdict

Round 1, commit f6cf8675: must-fix (three items). Round 2, commits ff6654aa and 9468436b: must-fix (one item, `update_agent` half-applied). Round 3, commit 13d0be2c: clean. Two fix rounds, then clean.

The browser proof is `docs/reviews/tasks/KY.10/browser.md`: PASS for admin and plain member at 1280x800 and 390x844, and for the member's refused server calls. The agent-owner case (flow 4) could not be run, because the local workspace has no runtime and "Create agent" stays disabled.

## What changed

- `requireAgentOwnerOrAdmin` in `guards.ts` now decides who may change an agent's apps, allowed tools, sign-in mode, Slack app and secret grants. An org admin session or an admin-access key passes. Anyone else, including a write key or a connected app, passes only as the agent's owner (`ownerUserId`, falling back to `createdBy`).
- Called from `connectors.assign` (new assignment, "whose sign-in" mode and allowed tools all go through it), `connectors.unassign` (also for an archived agent), `slackApps.paste`, `revoke` and `setListenMode`, `secrets.setGrants`, `grant` and `revoke`, and before `admin.updateAgent` saves anything when it carries connectors.
- Keys tab: `canManageAgentKeys` (renamed from `canSetAgentCredential`) disables Add app, Allowed tools, the sign-in select and Remove, replaces the Slack setup with a note, and hides "Passwords and keys" for everyone else. A member can still connect their own sign-in.
- Tests: owner, admin and plain member on assign, mode, allowed tools, unassign, Slack paste, revoke and listen mode, and secret grants; a write key, an OAuth write app and an admin key on assign and grants; `update_agent` with connectors saves nothing for a non-owner key; component tests for the disabled controls, the Slack note and the hidden secrets section.

## Nits left

- `admin.ts` `updateAgent`: a non-owner who resends connectors the agent already holds, with a field change, is now refused. Before, the held ones were skipped.
- `connectors.ts` `assign`: for a connector with a stored secret or header template, `requireSecretAdmin` accepts only an org admin's browser session, so `create_agent` and `update_agent` with such a connector from any key can still half-apply (the agent is made or updated, then the call fails). It predates this task.
- `agents.ts` `assertOwnerOrAdmin` (sessions only) and `guards.ts` `requireAgentOwnerOrAdmin` (admin keys count) are two owner-or-admin rules for the same agent, next to `requireAdminOrOwner` in `a2a/access.ts`. Fold them in a cleanup.
- `apps-section.tsx` works out `canManage` from `useAuth` again, although `KeysTab` already has it.
- A member sees no line saying why "Passwords and keys" is missing. The Slack and app controls do say.
- `admin.test.ts`: the new test sits under the admin-key describe, and no test shows an admin key adding connectors to an agent someone else owns.
- The assistant's secret card is still offered to a member. Granting to an agent they do not own now fails after the secret is created.
- Browser verifier: the "Subagents" switch is disabled for the member and the "Browser" switch is not. Browser was not in this task's list and its server side was not tested.

## Beyond the scope

- `agents.setOwners` accepts any user principal, so a plain member can name themselves the agent's owner (tRPC `agents.setOwners`, MCP `set_agent_owners`) and then pass every owner check here, in KY.8 and in the A2A rules. The reviewer says KY.10's guarantee holds only once this closes. Suggested task: only an org admin or the current owner may call `setOwners`; decide whether a creator who handed ownership over may take it back. Existing `setOwners` tests have the creator set owners twice in a row, so they need an owner or admin caller.
- An org admin working through a connected app (OAuth) now counts as the person only, since an OAuth principal carries no `isAdmin`. They can add connectors over MCP to agents they own, or use an admin key or the web app for others.
- An admin key keeps admin power after its minter is demoted. `requireKey` already treats keys this way.

## Test notes

- The full `bun run test` takes more than 10 minutes on a busy machine. A first run was cut off by the 10-minute command limit, and the next runs passed.

## Steps for Dom

None.
