# WS.3 review

Task: add-clerk's dev login makes the workspace row, and the WS docs are corrected.

## Verdicts

- Round 1 (972434b3): clean, 0 fix rounds. No must-fix.

## What changed

- The add-clerk snippet for `/api/dev-login` is now word for word the handler in `apps/web/src/server.ts`, including the `import.meta.env.DEV` block that makes the workspace row.
- `docs/HANDOVER.md` and `docs/reviews/tasks/WS.1.md` say staging runs on the Clerk dev instance (`faithful-falcon-1887.clerk.accounts.dev`). `add-workspace-helpers.ts` and `resolveSecretKey` already pick the dev key from `.env.local` for `--local` and `--remote --env staging`, and the production key for plain `--remote`. No code change was needed there.
- "allowed organisation" and "This organisation can't use Harbourmaster" are replaced in README, CLAUDE.md, both skills, `routes/index.tsx` and `triggers-router.test.ts`. The grep from the task finds nothing.

## Checks

- `bun run check && bun run test && bun run build` passed.
- Browser: with `.wrangler` deleted and migrations applied, `GET /api/dev-login` on a local `vite dev` ended on `/desk`. The snippet's handler is identical to the one in `server.ts`, so this covers the skill's code. No separate scratch copy of the boilerplate was made.

## Nits left

- `.claude/skills/add-clerk/SKILL.md:145`: the snippet calls `c.get("composed")`, which needs `composeServices` registered before the route. The skill does not mention it. It already holds in the boilerplate.
- Some replaced lines in CLAUDE.md and both skills were not re-wrapped.
- `CLAUDE.md:197` still calls the production Clerk instance "shared".

## Beyond scope

- The add-clerk skill could say that `composeServices` must run before `/api/dev-login`.

## For Dom

Nothing.
