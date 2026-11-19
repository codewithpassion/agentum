# RH.1 review

Round 1 at f92f4e8: clean, no must-fix. Check, test and build pass. The full `bun run test` hit unrelated flakes on different runs (a 200 ms timing test, a Rust "text file busy" test, a 51 s guest-execution test); each passed on a re-run and alone.

## Nits left

- The stub `jobLine` takes the first non-blank line of `soul`, 140 characters at most. RH.2 defines it as the first sentence of `instructions`, 80 characters at most, so RH.2 rewrites `roster.ts` and `roster.test.ts` for it.
- The column default is the neutral slate "?". Only `agents.create` derives the avatar from the name, and it is the only insert path today. A new insert path must call `defaultAgentAvatar`.
- A rename does not change the avatar glyph. Nobody decided whether it should.
- `avatar-migration.test.ts` finds its migration as the first file containing "`avatar`", so an earlier migration that mentions the word would make it test the wrong file.

## Beyond scope

- `AgentRecord` does not carry `avatar`. RH.4's room header needs it, or reads it from the card.
- No way to set the avatar yet (colour or glyph picker).

## For Dom

- The task's check "migration applies on a copy of staging data" is not done: it needs remote D1. Apply 0053 to a copy of the staging database and confirm every agent has a valid `avatar`. The migration applies locally with `wrangler d1 migrations apply DB --local`, and `avatar-migration.test.ts` checks the backfill against `defaultAgentAvatar`.
