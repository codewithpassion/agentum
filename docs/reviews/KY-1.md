# KY gate, round 1

Commit 24c672b6 on main, reviewed as `git diff ky-start..24c672b6` against the KY section of `docs/v4/build-plan.md`, the task files KY.1 to KY.13, `docs/reviews/KY-e2e.md`, the checkout's CLAUDE.md and "Rules that are easy to break" in `docs/HANDOVER.md`. I judged only the KY work.

## Verdict

Not clean. There are 2 must-fix findings, both about authorization. Dom's rule is that an agent's owners and workspace admins, and nobody else, manage its keys. The plan's Vocabulary defines Keys as "connectors, sign-ins, secrets, other agents, ask-before rules". KY.8, KY.10 and KY.13 closed connectors, the agent credential, sign-in mode, allowed tools, Slack app, per-agent secret grants and owners, and each has service tests for owner, admin and member. Two paths are still open to a plain member:

1. Any member can delete, re-value or re-scope any workspace secret. Deleting one removes it from every agent's grants.
2. Any member can change an agent's ask-before rules, its ask level and its hand-to agents. The Keys tab shows those controls to everyone.

The rest of the milestone holds up. The read model never returns a value or token, and only an admin or the owner sees other people's sign-ins. Members manage their own sign-ins. Connector create, edit and delete are admin-only in the service. The catalogue is admin-only and works on both the Keys tab and Settings, Apps. The fake tool mode goes through the real proxy with a real run token and is registered only when `devFakeRuntime` is on.

Checks on this commit in a clean worktree: `bun run check` passed, `bun run test` from the root passed (14 turbo tasks plus scripts), and `bun run build` passed from turbo's cache, with `check-dev-only` ok and no `drizzle` in `dist/client`. The targeted service suites (connectors, secrets, slack-apps, agents, admin, keys, catalog, connector-oauth, fake-runtime, fake-tool) passed, 295 tests.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | must-fix | `secrets.remove` and `secrets.update` need only workspace membership (`requireUser` plus the workspace `authorize`). A plain member can delete any secret, which deletes every agent's grant of it and resets connectors that used it. A member can also replace the value and edit the allowed hosts or proxy rules of a secret granted to an agent they don't own. The existing test "a member who is not an admin cannot change the mode, but can edit within it" asserts the host edit. `/settings/secrets` shows Delete, Replace, Rules and Hosts to members, although KY.6 says the page stays admin-only. KY.10 guarded `grant`, `revoke` and `setGrants` but not these. | services/secrets, settings | New task KY.14, below |
| 2 | must-fix | Ask-before rules, the ask level and hand-to agents are open to any member. `agentProfile.setAskBefore`, `agentProfile.setAskLevel`, the `requests.setRule` and `requests.removeRule` tRPC procedures, and `agents.update` with `handsTo` check only workspace membership. The Keys tab renders the ask-before card and the hand-to panel to every member. Both are Keys in the plan's Vocabulary ("other agents, ask-before rules"). They slipped because KY.10's decision lists only apps, tools, sign-in mode, Slack and secret grants, and KY.5 moved the ask-before card "unchanged". A member can turn off "ask before sending mail" on someone else's agent. The MCP `set_agent_ask_before` tool follows the same path. | services/agent-profile, requests, agents; web-keys | New task KY.15, below. Or Dom exempts these and the plan's Vocabulary row says so |
| 3 | nit | The agent's email identity (`agents.reserveAddress`, `mail.provision`, `mail.disable`) and the Browser switch on the Keys tab are open to any member. Neither is named in the Vocabulary row or in KY.10, so this needs Dom's call rather than a fix. | services/agents, mail; web-keys | Ask Dom |
| 4 | nit | Catalogue default allowed tools are applied only in the Keys tab client (`add-app-logic.ts`). A catalogue connector assigned by MCP `create_agent` or `update_agent` or by the agent builder gets every tool, which is the risk KY.5's scope note names. | services/connectors | Apply the entry's defaults in `connectors.assign` when `allowedTools` is absent and `catalog_key` is set |
| 5 | nit | `catalog.add` has no unique `(workspace_id, catalog_key)` index, so two concurrent adds make two connectors. The code says so. It also makes a second connector when an admin already added the same URL by hand. | services/catalog | Unique index in the next contract task, or leave it |
| 6 | nit | Dom's rule says "owners", and the UI copy says "the agent's owners and admins". The guard admits only the effective owner (`ownerUserId`, or `createdBy`), so the backup person is refused. That fits KY.13's wording, but the copy promises more. | guards, web-keys copy | Say "owner" in the copy, or ask Dom whether the backup counts |
| 7 | nit | `requireAgentOwnerOrAdmin` treats an admin API key as an admin. The read model's `showOthers` uses only `isAdmin` from the session, so an admin key can change keys but cannot see other people's sign-ins. | services/keys | Use the same admin test in both |
| 8 | nit | The Keys tab's `canEdit` blocks an owner who is not an admin from removing a secret-backed app. The server allows `unassign` for the owner. | web-keys | Align the UI with the server, or refuse in the server |
| 9 | nit | `docs/reviews/KY-e2e.md` still records FAIL for the tool-call step. KY.9's browser check passed at desktop size only and used a header connector. Nobody updated the walkthrough or re-walked the "member's own sign-in, then tool call" path through the fake runtime. | docs/reviews | Add a line to KY-e2e.md pointing at the KY.9 browser proof, or re-walk that step |
| 10 | nit | A member's OAuth start on a connector with no client runs dynamic registration and writes the client into the connector row. It is a connector write by a non-admin. It is needed for KY.3 and is harmless, but nobody has stated it as intended. | services/connector-oauth | Note it in the connectors README |
| 11 | nit | `proxyFetch` is built in every environment, though only the dev fake runtime reads it (already in the KY.9 review). | worker/compose | Leave, or build it only when `devFakeRuntime` is on |

## Task-ready scopes for the must-fix findings

### KY.14 Only admins change or delete a workspace secret

Lane `services-secrets` (service) plus `web-settings` (page). Executor claude.

Scope:

- `secrets.update` and `secrets.remove` refuse anyone who is not an org admin on a session or an admin key, matching connector edit and delete since KY.3. Default to making `secrets.create` admin-only as well, so `/settings/secrets` is the admin page KY.6 describes.
- A narrower alternative, if Dom wants members to keep managing secrets: refuse `update` and `remove` when the secret is granted to an agent the caller is not an owner of, using `requireAgentOwnerOrAdmin` for each granted agent.
- Leave the per-agent `grant`, `revoke` and `setGrants` rule as it is (owner or admin).
- `/settings/secrets` hides or disables New secret, Replace, Rules, Hosts and Delete for people the service refuses, and says why.
- Update the existing secrets test that lets a member edit hosts.

Check:

- Service tests for owner-not-admin, admin, admin key and plain member on update (value, hosts, rules) and remove. A refused remove leaves every agent's grants and the connector rows unchanged.
- Browser as a plain member on `/settings/secrets`: the write controls are disabled or hidden. As admin, they work.
- `bun run check && bun run test && bun run build` pass.

### KY.15 Only owners and admins change ask-before rules and hand-to agents

Decision first. Dom confirms that ask-before and hand-to are keys under his KY rule, as the plan's Vocabulary says. If he exempts them, record that in the Vocabulary row and close this task.

Lanes `services-agents`, `services-requests` and `web-keys`. Executor claude.

Scope:

- `agentProfile.setAskBefore`, `agentProfile.setAskLevel`, the `requests.setRule` and `requests.removeRule` procedures, and `agents.update` when `handsTo` is present all call `requireAgentOwnerOrAdmin` for the agent. The MCP `set_agent_ask_before` tool follows the same rule.
- The "Always allow" answer on a request stays open to any member. CLAUDE.md says any member may answer any request, and the answer path calls `setRule` internally. Put the new check where it does not block that path, for example in the router-facing methods or behind a flag the answer path sets.
- The Keys tab disables the ask-before card and the hand-to panel for everyone else, with the same note the other sections use.

Check:

- Service tests for owner, admin and plain member on each of the five writes. A refused call leaves the rules, the level and `hands_to` unchanged. A plain member's "Always allow" answer still writes its allow rule.
- Browser as a plain member: the ask-before switches, the level and the hand-to choices are disabled. As the owner, they work.
- `bun run check && bun run test && bun run build` pass.

## Verdict

Not clean: 2 must-fix (KY.14 secrets, KY.15 ask-before and hand-to), 9 nits.
