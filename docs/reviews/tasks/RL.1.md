# RL.1 review

## Verdicts

Round 1 at 97a23422: clean, no must-fix.

## Nits left

- `packages/db/src/rail-contract.test.ts` does not seed a row before 0035, so "existing rows get nulls" is only implied by the nullable, no-default check. A scratch run by the reviewer confirmed it.
- The trigger test asserts at least two `events` triggers, not their names.
- The heading test checks that the agent name appears, not the exact wording. The wording moved byte for byte from `needs-you-card.tsx`.

## Beyond the scope

- `packages/services/src/agents.ts` sets `ownerUserId` and `backupUserId` to null on create, which the new `AgentRow` type required. The services that read and write owner and backup come in later RL tasks.

## Steps for Dom

None. The migration 0035 applies with `wrangler d1 migrations apply DB --remote` at the next deploy.
