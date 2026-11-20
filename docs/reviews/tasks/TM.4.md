# TM.4 review: lead role, team tools and proposals

Dispatched with Haiku workers for three disjoint units (MCP team tools and the room-run list, the web ports and route, the launch-context connector cut). The dispatcher wrote the services core (`teams/lead.ts`, `teams/proposal.ts`, `teams/room-run.ts`, the request changes) and its tests. Reviewed by Opus.

## Rounds

- Round 1, at 19364744: must-fix. A proposal made from a limited topic could not be seen or answered by a member's owner who was not in the topic, because the card sits in the topic's inbox session. Fixed.
- Round 2, at 5a2ab68e (fix only): clean.

## Decisions the task left open

- A lead's tools are team tools only in a run in the inbox session of a topic of a team it leads (`teams/room-run.ts`). In its own conversations, and in a topic of a team it does not lead, it works as a normal agent and has no team tools.
- Room-run tool list: `agentumTools` takes `teamRoom`. It then returns the four team tools, every read-only tool and `send_message`. `launch-context.ts` also gives such a run no connectors.
- A proposal is a `run_requests` approval, tool `team_propose_change`, tool use id `team:<id>`, detached like mail approvals (no runtime waits on it, it outlives the lead's run). It lasts 3 days. It is opened with the member as the request's agent, so Needs you assigns it to the member's owner. The whole proposal is the card's input, so the owner approves exactly what is applied.
- `requests.answer` lets only the member's owner (or an admin) answer a proposal, and refuses Always allow.
- On Allow once, an `events.onAppend` listener in `teams/lead.ts` applies the change through `agents.update` as the approver. Instructions and model are fields. Effort and context budget are `runtimeConfig` keys. A denial, an expiry and a cancel change nothing.
- Fields are the four in the task. The input schema is strict, so access, keys, ask-before rules and connectors do not parse.
- Limits: the proposal must serialise to 7000 bytes, and it is refused if the card's scrub would change it (a token shape), so the card never differs from what is applied.
- A proposal from a limited topic is refused when the member's owner is not in the topic.
- `inbox.createThread` accepts a run principal only for a team it leads, and sets `openedByAgentId`. `createdBy` holds the agent id.
- `approvalSummary` has a line for the proposal: "<lead> proposes changing <agent>'s <field>".

## Nits left

- The card in Needs you is shown to everyone who sees the session. A non-owner who clicks Allow gets Forbidden. The Slack card goes to the person the lead's run acts for, not the member's owner.
- `request-card.tsx` still offers Always allow for a proposal. The server refuses it.
- A change that fails when applied after Allow (agent archived, model gone) is logged only. The card reads "answered".
- The scrub check does not cover the lead's secrets masker, so a value with a granted secret is applied masked.
- A lead can propose changes to itself.
- The approver is applied as a plain session user, even when the answer came from Slack.
- Proposals reuse `SKILL_CHANGE_TTL_MS`.
- `PROPOSAL_FIELDS` is defined in services and in `packages/mcp/src/ports.ts`; the effort and context words are in `tools/team.ts`.
- A room run with a computer keeps the read-only computer and browser tools while its connectors are cut.
- `request.*` events of a proposal name the member agent, while the run is the lead's.
- No test for the allowed limited-topic case.

## Ideas beyond the scope

- The built-in shell, file and web_fetch tools of the Pi, machine and managed runtimes are not part of the MCP list. A gate extension (`pi-run-gate.ts`) fed a `teamRoom` flag in the start would cut them in a room run.
- A cap on pending proposals per lead, so a lead cannot fill an owner's Needs you.
- A card for proposals with the before and after text, and a record of a failed apply.

## Steps for Dom

None. No migration, secret or dashboard change.
