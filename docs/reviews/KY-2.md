# KY gate, round 2

I reviewed commit 543ec95d on main as `git diff ky-start..543ec95d`. I read it against the KY section of `docs/v4/build-plan.md`, the task files KY.1 to KY.15, round 1 (`docs/reviews/KY-1.md`), the checkout's CLAUDE.md and "Rules that are easy to break" in `docs/HANDOVER.md`. I judged only the KY work. For other merges, I checked only whether they touch the key tables or the owner checks.

## Verdict

Not clean. There is 1 must-fix.

Both round 1 must-fixes are resolved.

KY.14 holds. `secrets.create`, `update` and `remove` now go through one check: an org admin on a browser session, or an admin API key. A write key, an OAuth client, a plain member and an owner who is not an admin are all refused. One test covers each of those principals on create, a value change, a host change, a rule change and remove. A second test shows that a refused remove leaves the grants and connector rows as they were. `/settings/secrets` disables every write button for non-admins and explains why. The only other caller of `secrets.create` is the admin MCP tool, and it uses the same service. The browser record covers an admin and a member at both sizes.

KY.15 holds. `setAskLevel`, `setRule`, `removeRule` and `agents.update` with `handsTo` now call `requireAgentOwnerOrAdmin`. `agentProfile.setAskBefore`, the MCP `set_agent_ask_before` tool and `update_agent` all reach those checks. The Always allow answer goes through a separate `recordAlwaysAllow`, which only the answer path and the held-mail release call. No router exposes it. The ask-before card, the mail allowed list and the hand-to panel are disabled for anyone else, with a note. The browser record covers admin, plain member, member-owner and an admin who is not the owner, at both sizes.

The must-fix is the agent's email identity. Round 1 listed it as nit 3 and asked for Dom's call. Nobody recorded a decision. I now rate it must-fix, because the KY contract makes it a key. KY.1 defines `AgentKeys` with five parts, and one of them is "identity (email address, Slack app state)". The plan's KY overview says the read model joins "mail and Slack identity". KY.10 closed the Slack half. The email half is still open to any member: `agents.reserveAddress` (tRPC `agents.reserveAddress`), `mail.provision` and `mail.disable` call only `requireUser` and the workspace `authorize`, and `authorize` admits any member of the workspace. On the Keys tab, the "Its own identity" section hides Slack setup from non-owners. The Email provision button sits under the same heading and shows to everyone. So a plain member can change the address of someone else's agent, open its mailbox to the internet, or turn it off.

I found no regressions from the other merges since round 1. The non-test diff since 24c672b6 touches `agent_connectors`, `slack_apps` and the owner fields only in reads (launch context, the Slack room) and in TM.4's proposal approval. That approval itself calls `requireAgentOwnerOrAdmin`, and TM.4 proposals cannot touch keys, ask-before or connectors.

Checks on this commit in a clean worktree all passed:

- `bun install --frozen-lockfile` and `bun run check`.
- `bun run test` from the root, 14 of 14 turbo tasks.
- `bun run build`. Turbo served it from cache. `apps/web/dist/client` exists and has no `drizzle`.
- The targeted service suites (secrets, requests, agent-profile, agents, keys, connectors, mail): 339 tests.
- The web suites for the Keys tab, the secrets components and the secrets router: 108 tests.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | resolved | Round 1 #1: any member could create, change or delete a workspace secret. | services/secrets, settings | KY.14 (9906fbca). Verified in code, tests and the browser record. |
| 2 | resolved | Round 1 #2: any member could change ask-before rules, the ask level and hand-to. | services/requests, agents, agent-profile; web-keys | KY.15 (30cc83d6). Verified in code, tests and the browser record. |
| 3 | must-fix | Any member can reserve or change an agent's email address (`agents.reserveAddress`), provision its mailbox (`mail.provision`) or disable it (`mail.disable`). KY.1 makes the email address part of `AgentKeys` identity, and the plan's overview pairs it with the Slack identity that KY.10 guards. On the Keys tab, Slack is gated and Email is not. Round 1 nit 3 asked Dom and got no recorded answer. | services/agents, mail; web-keys | New task KY.16, below. Or Dom exempts it, and the Vocabulary row says so. |
| 4 | nit | Copy now promises something the server refuses. The Keys tab secrets panel says "Add a secret under Settings, Passwords and keys, then grant it". That is only possible for admins now, yet the panel also shows to owners who are not admins. | web-keys (`profile/sheets/secrets.tsx`) | For a non-admin, say "Ask an admin to add the secret". |
| 5 | nit | The assistant's secret card calls `secrets.create` for any member. Since KY.14, a member fills in the value and then gets a Forbidden error. It fails closed, but the member types a secret for nothing. | web assistant (`assistant/cards.tsx`) | Don't offer the card to non-admins, or say before they type that only an admin can save it. |
| 6 | nit | When a member answers a held mail with Always allow, `allowOtherRecipients` writes allow rules for every outside recipient on that mail, not only the address the request asked about. That fits KY.15's answer-path exemption, but it widens more than one tool key. | services/mail/outbound | Confirm that the approval card names every recipient, or ask Dom to limit it to the asked key. |
| 7 | nit | `recordAlwaysAllow` is an unchecked public method on the requests service. Today only the answer path and mail release call it. A router that wires it in later would reopen finding 2. | services/requests | Add a test that no tRPC or MCP handler calls it, or leave it as is. |
| 8 | nit | Any member may revoke an agent's A2A connection. CLAUDE.md says so on purpose. It is still a change to "other agents" by a non-owner, which Dom's rule does not mention. | services/a2a | Record it in the Vocabulary row as an exemption, next to Always allow. |
| 9 | nit | The Browser switch on the Keys tab is open to any member (the other half of round 1 nit 3). The plan does not name it as a key. | web-keys, services/agents | Ask Dom, or leave it. |
| 10 | nit | Round 1 #4 is still open. `connectors.assign` does not apply catalogue default tools, so MCP `create_agent` and `update_agent` and the builder give a catalogue app every tool. | services/connectors | Unchanged since round 1. |
| 11 | nit | Round 1 #5 is still open. There is no unique `(workspace_id, catalog_key)` index. | services/catalog | Unchanged. |
| 12 | nit | Round 1 #6 is still open, and KY.15 repeats the copy. The new notes say "the agent's owners and admins", but the guard admits only the effective owner, not the backup. | guards, web-keys copy | Unchanged. |
| 13 | nit | Round 1 #7 is still open. An admin key passes `requireAgentOwnerOrAdmin`, but the read model's `showOthers` checks only the session `isAdmin`. | services/keys | Unchanged. |
| 14 | nit | Round 1 #8 is still open. The Keys tab's `canEdit` blocks an owner who is not an admin from removing a secret-backed app, though the server allows it. | web-keys | Unchanged. |
| 15 | nit | Round 1 #9 is still open. `docs/reviews/KY-e2e.md` still records FAIL for the tool-call step. | docs/reviews | Unchanged. |
| 16 | nit | Round 1 #10 is still open. When a member starts OAuth on a connector with no client, dynamic registration writes the client to the connector row, and nobody has documented that this is intended. | services/connector-oauth | Unchanged. |
| 17 | nit | Round 1 #11 is still open. `proxyFetch` is built in every environment. | worker/compose | Unchanged. |

## Task-ready scope for the must-fix

### KY.16 Only owners and admins change an agent's email identity

Decision first. Dom confirms that the email address and mailbox are keys, as KY.1's `AgentKeys` identity part and the plan's overview say. If he exempts them, record that in the Vocabulary row and close this task.

Lanes `services-agents`, `services-mail` and `web-keys`. Executor claude.

Scope:

- `agents.reserveAddress`, `mail.provision` and `mail.disable` call `requireAgentOwnerOrAdmin` for the agent. Use the same admin test as KY.10 (an org admin on a session, or an admin key).
- The admin MCP `reserve_agent_address` tool and any other caller follow the same rule through the service. The system principal stays allowed, because the tick runs `mail.provisionPending` with it.
- The Keys tab's "Its own identity" section hides or disables the Email provision button for everyone else. Show a note like the Slack one: "Only the agent's owners and admins can set up its email." Apply the same gating anywhere else the app offers address reservation or mail enable and disable for an agent.

Check:

- Service tests for owner, admin, admin key and plain member on reserve address, provision and disable. A refused call leaves `agents.email_local` and the `agent_mailboxes` row unchanged, and calls no routing rule.
- Browser as a plain member on another person's agent: no working email controls, and the note shows. As the owner, provisioning works. Check both sizes.
- `bun run check && bun run test && bun run build` pass.

## Verdict

Not clean: 1 must-fix (KY.16, email identity), 14 nits. KY.14 and KY.15 are resolved.
