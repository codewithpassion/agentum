# KY.13 review: only an agent's owners or an admin change its owners

## Verdict per round

Round 1 at a9ac2cd: clean, no must-fix. Six nits, none applied. No fix rounds.

## What changed

`agents.setOwners` now calls `requireAgentOwnerOrAdmin` once the agent is loaded. The current owner (`ownerUserId`, or `createdBy` when unset), an org-admin session and an admin API key may change owners. Anyone else gets a forbidden error and the owners stay as they were. The MCP `set_agent_owners` tool goes through `admin.setAgentOwners` into the same method, so it follows the rule. The Owner and Backup selects in the room's Settings tab are disabled unless the caller is the owner or an admin, using `canManageAgentKeys`.

The backup is not counted as an owner, which follows the KY.8 and KY.10 rule.

## Nits left

- `packages/mcp/src/tools/agent-management.ts:72`: the `set_agent_owners` description does not say only the owner or an admin may call it.
- `docs/v3/workspace-assistant.md:21` still lists `set_agent_owners` among tools any member can use.
- `packages/services/src/guards.ts:58-63` and `apps/web/src/components/agent/room/keys/keys-logic.ts:145-150`: the doc comments do not mention owner and backup. The Settings tab uses a helper named for the Keys tab.
- `apps/web/src/components/agent/room/settings/index.tsx:7`: relative import of `../keys/keys-logic.ts` where the file's other imports use `#/components/...`.
- `apps/web/src/components/agent/profile/asks-row.tsx:121,145`: a member sees greyed-out selects with no line saying why. The Keys tab hides its controls instead.

## Ideas beyond the scope

- Rename `canManageAgentKeys` to something like `canManageAgent` and give it a neutral home, since it now decides owner changes too.
- Show a short "Only the owner or an admin can change this" note under disabled controls.

## Steps for Dom

None.
