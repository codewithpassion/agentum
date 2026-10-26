# Codex orchestration guide

Copied on 17 Oct 2026 from Dom's doc https://claude.ai/artifact/LxJ5TPRYK2fHazGamqgLLS. Source project: AI CAMO Platform build, October 2026, about 370 tickets.

A Claude Code coordinator ran OpenAI Codex as its main implementation lane. Claude plans, routes, reviews and merges. Codex writes most of the code. Copy the parts that fit your project.

## Setup

- **Plugin.** Use the openai-codex Claude Code plugin, through the fork `codewithpassion/codex-plugin-cc`. With the fork, Codex can `git add` and `git commit` inside linked worktrees. The entry point is `~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs`.
- **Model.** `gpt-6.1-sol` at medium effort, always with `--write`.
- **Sandbox network.** Turn it on in `~/.codex/config.toml`:

```toml
[sandbox_workspace_write]
network_access = true
writable_roots = ["/home/roboto/.config/.wrangler"]
```

- **Writable roots.** Without the Wrangler root, Wrangler writes fail with EROFS and the D1/Miniflare tests fail. The plugin passes its own thread-level `writable_roots`, and those replace the config list. Patch `scripts/lib/codex.mjs` (`readConfigWritableRoots`) to merge the two lists. A plugin update loses the patch, so carry it in the fork.
- **Why network.** With network on, Codex runs the D1 tests itself. Offline, every Codex ticket needed a second verify outside the sandbox.

## One ticket, end to end

The coordinator writes briefs and starts jobs. It never implements, opens PRs or merges itself, and that keeps its context small enough to run for days.

1. **Worktree.** The coordinator makes one linked worktree per ticket with `git worktree add --no-track ../camo-wt-<key> -b <branch> origin/main`. It then runs `bun install`, the worktree setup and the type generation there. Codex never makes its own worktree.
2. **Brief.** A script (`lane.sh`) builds one brief file per ticket. Nobody types a brief by hand. It holds the ticket's plan section, the READMEs to read first, the rules below and a fixed footer with the commit trailers and the answer format.
3. **Start.** Run this inside the worktree. The last output line holds the job id.

```sh
node codex-companion.mjs task --background --write --fresh \
  --model gpt-6.1-sol --effort medium --cwd <worktree> "$(cat brief.md)"
```

4. **Watch.** Run `codex-companion.mjs status <job> --wait` as a background shell command, looped until the status is no longer running or queued. The harness wakes the coordinator when it exits. Never poll with sleep.
5. **Collect.** Run `codex-companion.mjs result <job>`, and read `git log origin/main..HEAD` for Codex's notes. Then run `bun run codex:stop-idle <worktree>` to kill the idle helper process Codex leaves behind.
6. **Land.** A Sonnet subagent works in the same worktree. It merges main, runs `ultracite fix` and the full `bun run verify`, pushes, opens the PR and comments on the Linear issue.
7. **Review.** Tickets of 3 points or less get a Sonnet review. Tickets of 5 points or more get an Opus review, and so does anything touching core, security or approvals.
8. **Fix rounds.** A `forge-light` (Sonnet) agent fixes in the same worktree. Later rounds resume that same agent with SendMessage, so it keeps its context. A fix that changes production code gets a short Opus re-check.
9. **Merge.** A Sonnet agent merges from a templated brief. It merges main and regenerates any colliding migration, never renumbering by hand. It runs one full verify, then `gh pr merge --merge`. A cleanup script removes the worktree afterwards.

## Rules every Codex brief carries

- Test first. Commit as you go with `git commit --no-verify`, at least once before the final answer. A job that ends uncommitted loses its work.
- Never run the full `bun run verify`. Run only the affected package tests and typecheck. The verify lock allows 3 runs per machine, and a Codex job that waits for one can stall and end without committing (E31-01).
- Run `ultracite fix` only on the files you changed. The husky pre-commit hook may fail in the sandbox, so commits use `--no-verify`, and the land agent runs ultracite outside it.
- Don't push. The land agent pushes.
- No browser. For UI work, use the existing shadcn and domain components, and list the exact UI path and steps for the browser check. A separate Sonnet agent does that check.
- If the plan is ambiguous, pick the reading that matches the plan and conventions, note it in a code comment, and list it in the answer. Don't stop to ask.
- Final answer of at most 8 lines: commits, PASS/FAIL per acceptance criterion, tests run and tests not runnable, ambiguities resolved.

## Concurrency and limits

- At most 8 implementers at once, Codex jobs included. Start the next ticket as one finishes.
- Run Codex jobs in parallel, each in its own worktree. To continue a job, resume it by its job or session id. `--resume-last` can pick up another worktree's session.
- Check the status output for ChatGPT's usage-limit message before you treat a job as finished. On 16 Oct the limit hit mid-batch and killed two jobs, one with uncommitted changes. The fallback is a `forge-light` agent that commits Codex's leftover work first, then finishes the ticket in the same worktree.
- The full verify and the D1 suites are heavy. If a d1 test in an untouched file times out under load, re-run it alone with a longer timeout before you call it a failure.

## What worked and what didn't

- On most tickets Codex quality was close to Opus. E42-01 and E40-05 each needed only one review round. Codex costs nothing per token next to API models, so from 13 Oct it also took UI tickets.
- Reviews still find real bugs in Codex code. On E52-10, a request-admission flag was shared across the calls of one tRPC batch. On E41-07, adoption events made an approval's impact stale. Keep the review step, and never merge on Codex's own PASS lines.
- Codex sometimes files follow-up issues in Linear with no project set. Check for orphans after its jobs finish.
- Keep briefs as files built from templates with sed placeholders (`{PR}`, `{KEY}`, `{BRANCH}`). Long briefs typed into a message drift and lose rules.
