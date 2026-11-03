# Working process

How Agentum gets built. The controller follows all of it. Subagents get their part through briefs written from the templates at the end.

## Roles

| Role | Agent call | Started by | Job |
|---|---|---|---|
| Controller | Opus, the main session | Dom | Picks ready tasks, makes worktrees, starts dispatchers and milestone reviewers, merges, owns `docs/tasks/`. Writes no product code. |
| Dispatcher | `model: "sonnet"`, `effort: "high"` | Controller, one per task | Splits its task into units, runs workers, integrates, runs the task's check, commits, runs the review loop and makes review fixes. |
| Worker | `model: "haiku"`, `effort: "medium"` | Dispatcher, one per unit | Does one unit in the dispatcher's worktree and runs the unit's check. |
| Reviewer | `model: "opus"`, `effort: "medium"` | Dispatcher for a task, controller for a milestone | Reviews a task branch or a milestone. Reads only. |
| Codex | `scripts/codex-task.sh` (Codex CLI, `gpt-6.1-sol`, medium) | Dispatcher of an `executor: codex` task | Implements the whole task in the dispatcher's worktree from a brief file and commits as it goes. Can't ask questions or use a browser. |

At most 6 dispatchers run at once, each with at most 4 workers, and at most 3 of them driving a Codex job. Two tasks with the same `lane` never run at once, because their files overlap and their merges would conflict. Raise a role's effort for a task only after a run at the listed level fell short.

## Tasks

Each task is one file, `docs/tasks/<id>-<slug>.md`. The body holds the scope and check copied from `docs/architecture/build-plan.html`, then a log. The frontmatter:

```yaml
id: M0.2
title: Foundation schema, migrations, atomic port
milestone: M0
size: M            # S, M or L
status: todo       # todo | in_progress | review | done | blocked
depends_on: []     # task ids
branch: null       # set when dispatched
lane: services     # v2 tasks: db, services, worker, web, daemon, mcp, slack, computer, email, ops or docs
executor: claude   # v2 tasks: claude (Haiku workers) or codex (one Codex job)
```

v2 tasks (`V<n>.<k>`) carry `lane` and `executor`. Their scope comes from `docs/v2/build-plan.md` and the task file itself. Each v2 milestone starts with a contract task, `V<n>.1`, which alone changes `packages/db/src/schema` and generates migrations, so parallel tasks never collide on migration numbers.

A task is ready when it is `todo` and every task in `depends_on` is `done`. `bun run tasks` lists all tasks, marks the ready ones with `*`, and fails on an unknown status or dependency.

Only the controller edits task files, in the main checkout, and commits each change straight to `main` (`tasks: M0.2 in_progress`). Every status change also appends a dated line to the task's log: dispatched, review verdict, merged, blocked and why. The frontmatter and the logs are the handoff, so a new controller session reads this file and runs `bun run tasks`.

Units are not files. The dispatcher plans them in its own context.
## Worktrees and cleanup

Every worktree lives in one folder beside the main checkout, `/home/roboto/devel/harbourmaster-wt/`. Keeping it outside the repo stops Biome and searches from scanning the copies. Inside it, a task's worktree is `<id>`, a reviewer's checkout is `review-<id>-<sha>`, and a task's logs and scratch files go in `tmp/<id>/`.

`bun run clean` removes the worktrees, `tmp/` folders and `task/*` branches of every `done` task, prunes git's worktree list, and prints what remains with its size. It keeps a worktree with uncommitted changes or a branch not merged into `main`, and says why. The controller runs it after each merge and at the start of each session.

## GitHub

Dom is on the free GitHub plan, so the build uses no Actions minutes. Work happens on local branches and merges into `main` locally. Nobody opens pull requests. No workflow may trigger on `push` or `pull_request` until Dom says so; a workflow that needs adding gets `workflow_dispatch` as its only trigger. The controller pushes `main` after each merge. Task branches stay local.

## The loop

Dom starts the controller session in `/home/roboto/devel/harbourmaster`. The controller keeps the loop running without waiting on Dom. While a task is ready and a dispatcher slot is free, it dispatches. It ends a turn only to wait for running agents, or when nothing can move without Dom. Status notes go in the same message as the next tool call.

The controller's context is the scarce resource. Everything about a task goes through its dispatcher: worktree setup, workers, review, fixes and follow-up notes. The controller reads only the dispatcher's two-line report and the exit code of its own merge check. It doesn't read reviews, diffs or logs, and it doesn't fix or edit anything a task touches.

1. Take the ready task with the lowest id whose `lane` no running task holds. Repeat while dispatcher slots are free.
2. Set `status: in_progress` and `branch`, and start a dispatcher with the dispatcher brief.
3. The dispatcher sets up its worktree, builds, and runs the review loop on its own branch until the verdict is clean. It records the verdict, nits and follow-ups in `docs/reviews/tasks/<id>.md` on its branch, brings `main` in, and reports ready with the head SHA.
4. A dispatcher still at must-fix after two fix rounds reports blocked with a one-line reason, and the controller decides.
5. On ready: in the main checkout, `git merge --no-ff task/<id>-<slug>`, run `bun install && bun run check && bun run test && bun run build`, then `git push origin main`. If a check fails, undo the unpushed merge with `git reset --hard ORIG_HEAD` and send the failure to the dispatcher. Set `status: done`, stop the dispatcher with TaskStop, and run `bun run clean`.

Merge one branch at a time. A merge that conflicts is aborted with `git merge --abort` and goes back to the dispatcher, which merges `main` in, re-runs its checks and reports ready again.

A dispatcher that cannot finish reports blocked. Set `status: blocked` with a one-line reason and bring it to Dom if it needs a decision. When Dom says stop, start nothing new; running tasks finish to merged or blocked.

Milestone gate. Before dispatching a milestone's first task, tag `main` with `<milestone>-start` (for example `m1-start`) and push the tag. When every task in the milestone is done, start one reviewer with the milestone variant of the reviewer brief. The reviewer writes its findings to `tmp/<milestone>-gate/<milestone>-<n>.md` with a verdict, a findings table (severity, finding, area, resolution) and a task-ready scope and check per must-fix, and reports three lines; the controller copies the file to `docs/reviews/`. Each must-fix finding becomes a new task in that milestone. After two gate rounds, open findings stay recorded in the review file and the milestone closes.

## Briefs

Subagents can't be relied on to load the repo's `CLAUDE.md`: a test subagent saw only the global one. Every rule a subagent needs therefore travels in its brief. The controller writes dispatcher and milestone reviewer briefs, and dispatchers write worker and task reviewer briefs, from the templates below. Fill the `<...>` fields, copy the rest word for word, end with the agent rules block, and add nothing the task file doesn't say.

Start agents without a `name`. The starting agent stops an agent with TaskStop once it has the report. A dispatcher stays until its branch merges.

### Dispatcher

```text
You are the dispatcher for Agentum task <id>, <title>.
Task file: /home/roboto/devel/harbourmaster/docs/tasks/<file>. It is the whole spec.
Worktree: /home/roboto/devel/harbourmaster-wt/<id>, on branch task/<id>-<slug>.

Keep working until everything in the task file is done. Stop to ask only when you can't go on without the controller or Dom. The controller's context is scarce, so handle everything about the task yourself and send it only the final report.

0. Set up: `git -C /home/roboto/devel/harbourmaster worktree add /home/roboto/devel/harbourmaster-wt/<id> -b task/<id>-<slug> main`, then `bun install` in the worktree and copy `apps/web/.env.local` from the main checkout.
1. Read the task file. Read other docs only where the task names them.
2. Split the task into units. A unit touches one to three files, states the change, and has its own check, usually `bun test <file>`. Units that run at the same time touch disjoint files.
3. Start a worker per unit with model "haiku" and effort "medium", without a name, at most 4 at once. Write each brief from the Worker template in /home/roboto/devel/harbourmaster/docs/workflow.md.
4. A unit that fails its check twice, you do yourself.
5. When the units are in, run the task's check, then `bun run check && bun run test && bun run build` from the worktree root. Done means all of them pass.
6. Commit with the task id first ("<id>: ...") and the Co-Authored-By trailer.
7. Start a reviewer with model "opus" and effort "medium", without a name, on your head SHA. Write its brief from the Reviewer template in /home/roboto/devel/harbourmaster/docs/workflow.md.
8. A must-fix verdict: apply the must-fix items, run `bun run check && bun run test`, commit, and start a new reviewer on the fix commits only. After two fix rounds that still end must-fix, stop and report blocked with the open findings.
9. A clean verdict: write `docs/reviews/tasks/<id>.md` with the verdict per round, the nits you left, ideas beyond the scope, and steps for Dom. Run `git merge main`, re-run `bun run check && bun run test && bun run build`, and commit.
10. Report in at most two lines: "<id> ready at <sha>, review clean after <n> fix rounds." plus, only if there are any, "Dom: <steps that need Dom's accounts or dashboards>". A blocked report is one line with the reason.

Workers leave git to you because parallel commits in one worktree collide on the index. Never edit docs/tasks/; that is the controller's.

The controller may send a failure from its merge check or a merge conflict. Fix it through steps 5 to 10. Bring main in with `git merge main`, never a rebase.

A browser step in the task's check is yours. Run `bunx wrangler d1 migrations apply DB --local && bunx vite dev --port <free port other than 3000>` in apps/web, then use the agent-browser skill with your own session name.
```

### Worker

```text
You are a worker on Agentum task <id>, in the worktree /home/roboto/devel/harbourmaster-wt/<id>.
Files you may change: <files>.
Change: <what to do>.
Check: <command>.

Keep working until the check passes. A check counts only if it exercises the change: a test, the type-checker or the build. A syntax-only check, or a command that failed to start, doesn't count. Write logic that works for all valid inputs, not code shaped to the test's values. If the check can't pass, or a test in it looks wrong, report what fails instead of working around it. When the check passes, stop and report in at most 5 lines. The dispatcher commits, so leave git to it.
```

### Reviewer

```text
Review Agentum task <id> at commit <sha> (branch task/<id>-<slug>).
Task file: /home/roboto/devel/harbourmaster/docs/tasks/<file>.
<Re-review only: Review the commits after <previous sha>.>
<Milestone gate instead: Review git diff <milestone>-start..<sha> as a whole against the milestone's section of docs/architecture/build-plan.html (v1) or docs/v2/build-plan.md (v2).>

Check out the commit with `git -C /home/roboto/devel/harbourmaster worktree add --detach /home/roboto/devel/harbourmaster-wt/review-<id>-<sha> <sha>` and remove it with `git worktree remove` when done. Review against the task file's scope and check, CLAUDE.md in that checkout, and "Rules that are easy to break" in docs/HANDOVER.md. Change no files.

Report every finding you believe is real, minor ones included, one line each with file:line, marked must-fix or nit. Whoever started you does the filtering. End with the verdict: clean when nothing is must-fix.
```

### Agent rules block

```text
Rules for this build:
- Work only in your worktree. The main checkout /home/roboto/devel/harbourmaster and its docs/tasks/ belong to the controller.
- Before changing or reviewing code, read CLAUDE.md at your worktree root for the repo's code rules.
- Logs and scratch files go in /home/roboto/devel/harbourmaster-wt/tmp/<id>/. Run dev servers and builds in the background with output to a log file there, and read the tail when they finish.
- Stop processes only by the PIDs you started.
- Deploys, remote D1, Worker secrets and git push are for Dom and the controller.
- Deliver your report by ending your turn, not with SendMessage. Report what you did, commit SHAs, checks run with their results, and blockers. Leave out code, diffs and logs.
```

### Dispatcher, Codex addendum

For an `executor: codex` task, the controller appends this to the dispatcher brief:

```text
This task's implementation runs in Codex, not Haiku workers. Replace steps 2 to 4:
2. Write the Codex brief to /home/roboto/devel/harbourmaster-wt/tmp/<id>/codex-brief.md from the Codex template in docs/workflow.md, with the task file's text pasted in.
3. Start it in the background: `scripts/codex-task.sh <worktree> <brief file> <log dir>`, as a Bash background command. It exits when Codex ends or after 90 minutes.
4. Read the last message file it names. If Codex stopped short, hit a usage limit or left changes uncommitted, commit what it left ("<id>: codex leftovers") and finish the task yourself with Haiku workers.
Then continue at step 5. The review in step 7 is never skipped for Codex code, and a Codex PASS line is not evidence: run the checks yourself.
```

### Codex

```text
You implement Agentum task <id>, <title>, in this git worktree. The task file below is the whole spec.

Rules:
- Read CLAUDE.md at the worktree root first, then the files the task names.
- Write the tests first, then the code. Commit as you go with `git commit --no-verify -m "<id>: ..."`, at least once before your final answer. Uncommitted work is lost.
- Run only the affected package's tests and `bun run check`. Never run `bun run test` or `bun run build` for the whole repo.
- Never change packages/db/src/schema or migrations, wrangler.jsonc, secrets or deploy anything. Never push.
- No browser. For UI, use the existing shadcn and app components.
- If the spec is ambiguous, pick the reading that fits the task and the code's conventions, note it in a code comment, and list it in your answer. Don't stop to ask.
- Final answer in at most 8 lines: commits, PASS or FAIL per check bullet, tests run, tests you couldn't run, ambiguities resolved.

<task file text>
```

## Checks

`bun run check` runs Ultracite and typecheck. `bun run test` and `bun run build` run through turbo. `bun run dev` is pinned to port 3000, which is why worktrees start Vite on their own port.
