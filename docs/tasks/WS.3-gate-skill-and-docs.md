---
id: WS.3
title: "add-clerk's dev login makes the workspace row, and the WS docs are corrected"
milestone: WS
size: S
status: done
depends_on: [WS.1, WS.2]
branch: task/WS.3-gate-skill-and-docs
lane: docs
executor: claude
---

From the milestone gate, `docs/reviews/WS-1.md`, must-fix M2 and the wording nits.

## Scope
- `.claude/skills/add-clerk/SKILL.md`: add the `import.meta.env.DEV` block from the `/api/dev-login` handler in `apps/web/src/server.ts` to the skill's snippet, and update the snippet's header comment. A fresh copy's one-click login otherwise lands on `NoAccess` on a clean `.wrangler`.
- `docs/HANDOVER.md` line 8 and `docs/reviews/tasks/WS.1.md` (For Dom): both say staging runs on the shared production Clerk instance. It runs on the dev instance: `.env.staging` holds a `faithful-falcon-1887.clerk.accounts.dev` key. Correct them, including what `add-workspace --remote --env staging` reads, and check `apps/web/scripts/add-workspace-helpers.ts` picks the matching key for each environment.
- Replace the old wording: "This organisation can't use Harbourmaster" in `README.md`, `.claude/skills/add-clerk/SKILL.md` and `.claude/skills/setup-cloudflare/SKILL.md`, and "allowed organisation" in `CLAUDE.md`, the comment in `apps/web/src/routes/index.tsx` and the test name in `apps/web/src/server/trpc/triggers-router.test.ts`. Say what the code does now: an organisation needs a workspace row.

## Check
- The snippet's handler matches the `/api/dev-login` handler in `apps/web/src/server.ts`.
- Following the skill's snippet in a scratch copy, with `.wrangler` deleted, one-click dev login lands on `/desk`.
- `grep -rI "allowed organisation\|can't use Harbourmaster" apps packages .claude CLAUDE.md README.md` finds nothing.
- `bun run check && bun run test && bun run build`.

## Log
- 2026-11-02: created from the WS gate, and dispatched.
- 2026-11-02: review clean after 0 fix rounds. Merged and pushed. Docs, a skill and a comment only, so it needs no deploy on its own.
