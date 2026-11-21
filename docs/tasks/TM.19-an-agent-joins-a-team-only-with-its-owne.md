---
id: TM.19
title: "An agent joins a team only with its owner's consent"
milestone: TM
size: S
status: done
depends_on: [SL.11]
branch: task/TM.19-an-agent-joins-a-team-only-with-its-owne
lane: services-teams
executor: claude
---

From the TM gate review, round 1 (`docs/reviews/TM-1.md`, must-fix 1).

## Scope

- `teams.addMember` with `memberKind: "agent"` needs the agent's owner (`effectiveOwner`) or an admin. So does `teams.create` with a `leadAgentId`. Use the owner check already in `requests.ts` (`requireAgentOwnerOrAdmin`).
- `isHome: true` for an agent is honoured only from its owner or an admin. For anyone else the flag is ignored and the first-home rule applies.
- `teams.removeMember` also lets the agent's owner remove their own agent from any team, archived or not.
- The default is the plain check above: a team owner who does not own an agent asks its owner to add it. Dom decides whether to add an invite instead, which would be a request in the agent owner's Needs you that adds the agent on approval. List this in the task file as an assumption.
- Leave existing memberships alone. The task file says how many cross-owner memberships staging and production hold, from a read-only query Dom runs.

## Check

- `teams.test.ts`: a team owner who does not own an agent cannot add it, make it lead at create, or move its home. The agent's owner and an admin can. The agent's owner can remove it from a team they do not own.
- A web test or the team page's component test shows the Forbidden message when a non-owner picks another owner's agent.
- `bun run check && bun run test && bun run build` pass.

## Controller decisions

- Default kept: only the agent's owner or an admin may add it to a team, make it lead or set its home. No invite flow.
- The controller runs the read-only count of cross-owner memberships on staging and production and logs it here.

## Log
- 2026-11-21: added by controller.
- 2026-11-21: controller ran the read-only count on remote D1. Production and staging hold 0 cross-owner agent memberships (team owner differs from the agent's owner, or either is unset). Nothing to migrate.
- 2026-11-21: dispatched.
- 2026-11-21: ready at 2a35372a, review clean with no fix rounds.
- 2026-11-21: merged 3f54e6b6, merge check passed (agentum-rs tests included). Done.
