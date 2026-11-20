# KY.15 review: only owners and admins change ask-before rules and hand-to agents

## Verdict per round

Round 1, 30cc83d6: clean. No must-fix, four nits. The reviewer checked every write path to tool rules, the ask level and `hands_to` (tRPC, the MCP `set_agent_ask_before` tool, the agent builder, Slack, teams, desk) and found none that skips the owner or admin check. `bun run check`, `bun run test` and `bun run build` pass.

Browser proof on the merged head, desktop 1280x800 and phone 390x844: pass. Admin, a plain member on an admin's agent, a member on their own agent, and an admin on a member's agent. See `docs/reviews/tasks/KY.15/browser.md`.

## What changed

`requests.setAskLevel`, `setRule` and `removeRule` call `requireAgentOwnerOrAdmin`, so `agentProfile.setAskBefore`, `agentProfile.setAskLevel`, the `requests.rules` routes and the MCP tool follow. `agents.update` calls it when `handsTo` is present. A write key or connected app counts only as the agent's owner, as the guard already says.

The Always allow answer stays open to any member through a new `requests.recordAlwaysAllow`, which writes an allow rule without the owner check. `requests.answer` and the mail release (`mail/outbound.ts`) use it. The tRPC routers and MCP do not reach it.

The Keys tab (`room/keys/index.tsx`) passes `canManage` to the ask-before card and the hand-to panel. For everyone else the level radios, the ask switches and the mail Remove buttons are disabled with one note, and the hand-to checkboxes are disabled with another.

## Nits left

- `requests.ts` `setRule`: it parses and loads the agent, then `putRule` does both again. Two lookups per call.
- `requests.ts` `recordAlwaysAllow`: it sits on the public service and skips the check, guarded by a comment only. A new internal caller would bypass the rule without noticing.
- `hands-to.tsx`: no unit test that the rows are disabled for a member, because they render after the agent list loads. The browser proof covers it.
- `ask-before-card.test.tsx`: the per-action switches and "Ask again" sit in closed disclosures, so the markup test does not see them. The browser proof covers them.

## Ideas beyond the scope

- `agents.update` checks that `handsTo` is present, as the task says. Checking that the value changes would stop a full-patch caller from being refused for an unchanged list. No caller sends one today.
- The Subagents switch is disabled for a member with no note, unlike the two sections this task changed.
- `a2a/tool-gate.test.ts` wrote rules as a non-owner member. It now uses the fixture's owner, `u-owner`.

## Steps for Dom

None.
