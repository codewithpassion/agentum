# SP.1 review

## Verdict

Round 1, commit e60993da: must-fix. Two items. `resume` took no new cap although SP.3 resumes "optionally with a new cap", and no procedure read the workspace cap or an agent's cap and pause, which SP.4 needs.
Round 2, commit 2f67515a: must-fix. `isRealDay` threw a RangeError on a day such as `2026-13-45` instead of failing validation, so a caller using `safeParse` directly would crash.
Round 3, commit 5bcabb8f: clean. No must-fix findings.

The fixes: `spend.resume` takes `{ agentId, weeklyCapCents? }` (positive cents, null to remove, left out to keep) and returns `SpendResume` (the pause plus the cap). `spend.caps` returns `SpendCaps` (the workspace cap and one `AgentSpendCap` per agent). Days must be real and `from` may not follow `to`. The unused `SpendRange` type is gone, and the `spend_pause` heading reads "<name> stopped at its weekly limit", since the workspace cap pauses agents too.

## What the contract holds

Migration 0056 adds `agents.weekly_cap_cents`, `agents.paused_at`, `agents.paused_reason` and `workspaces.weekly_cap_cents`, all nullable with no default. `@repo/db/shared` has `SPEND_PAUSE_REASONS`, `SpendRow`, `SpendPause`, `SpendCap`, `SpendResume`, `AgentSpendCap`, `SpendCaps` and the `spend_pause` Needs you kind. `@repo/services/spend` has `workspace`, `byAgent`, `caps`, `setCap` and `resume`. Reads return empty values. Writes are `not_found`. The service takes `{ atomic, clock, db }` and ignores them, so SP.2 and SP.3 do not edit `compose.ts`. The tRPC router is `spend`.

## Nits left

- `packages/services/src/spend.test.ts`: the cap test also covers the optional cap on `resume`, and has no negative value. Cosmetic.
- `spend.setCap` and `spend.resume` authorize for any member of the workspace. Who may set a cap (an org admin, the agent's owner) is not decided. SP.3 settles it, and the SP.4 UI must match.
- `SpendRow.day` is documented as `YYYY-MM-DD` only. The timezone is SP.2's call (the task says the workspace timezone).
- The `manual` pause reason exists as the task asks, but no SP task adds a manual pause.

## Beyond the scope

- `AgentCard.weeklyCapCents` (RH.1) is still a hard-coded null in `roster.ts`. Now that the column exists, RH.2 or SP.3 can read it.
- SP.3 raises the `spend_pause` item. `needs-you-card.tsx` and the rail source for it are SP.4 and RH work. `NEEDS_YOU_HEADINGS` already has the entry.
- `Workspace` in `packages/services/src/workspaces.ts` does not carry `weekly_cap_cents`. SP.4 can read the workspace cap through `spend.caps`.

## Test notes

- `bun run check` and `bun run build` pass. The `drizzle` grep of `apps/web/dist/client` is empty. The migration applies with `wrangler d1 migrations apply DB --local`.
- `bun run test`: only `guest-execution.test.ts` in apps/web fails (the known flake). A run in round 2 also hit the 60 s timeout of the `runs.test.ts` test "an hour of never-claimed runs stays bounded", which takes 59.8 s alone on this host and passed alone. A reviewer saw two Rust tests in `apps/agentum` fail on the session bus and process groups. The change touches no Rust.

## Steps for Dom

- Apply migration 0056 to staging and production (`bunx wrangler d1 migrations apply DB --remote` from `apps/web`, with `--env staging` for staging). It adds four nullable columns, so existing rows are safe.
