---
id: RL.1
title: "Rail contract: owner and backup on agents, attention on runs, shared types"
milestone: RL
size: S
status: done
depends_on: []
branch: task/RL.1-rail-contract
lane: db
executor: claude
---

Spec: `docs/ux-review/rail/spec.md`, the section "Data contract (RL.1)" and the Rules. The spec is part of this task and wins over anything else. The clickable design is `docs/ux-review/rail/design.html` (open it with Playwright or read the source, including `?who=dan` and `?scope=everyone`). Why: `docs/ux-review/review.md`.

## Scope
- The four schema columns, one generated migration including `migrations/meta/`.
- The constants and types in `packages/db/src/shared.ts`, exactly as the spec lists them.
- Move the wording of `HEADINGS` from `needs-you-card.tsx` into `packages/db/src/shared.ts` as `NEEDS_YOU_HEADINGS`, and import it back in the card, with no change on screen.

## Check
- `bun test` in `packages/db` passes, and the new migration applies on the test database (`migrated()`), with existing rows getting nulls.
- The `events` triggers survive the migration (it must not recreate `events`).
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-30: created from Dom's request to design, spec and build the rail.
- 2026-10-30: dispatched.
- 2026-10-30: merged, review clean.
