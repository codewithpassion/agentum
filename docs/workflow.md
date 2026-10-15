# Working process

How Harbourmaster gets built. The controller follows all of it. Dispatchers, workers and reviewers follow the section with their name.

## Roles

| Role | Agent call | Started by | Job |
|---|---|---|---|
| Controller | Opus, the main session | Dom | Picks ready tasks, makes worktrees, starts dispatchers and reviewers, merges, owns `docs/tasks/`. Writes no product code. |
| Dispatcher | `model: "sonnet"`, `effort: "high"` | Controller, one per task | Splits its task into units, runs workers, integrates, runs the task's check, commits, makes review fixes. |
| Worker | `model: "haiku"`, `effort: "medium"` | Dispatcher, one per unit | Does one unit in the dispatcher's worktree and runs the unit's check. |
| Reviewer | `model: "opus"`, `effort: "medium"` for a task, `"high"` for a milestone gate | Controller | Reviews a task branch or a milestone. Reads only. |

At most 3 dispatchers run at once, each with at most 4 workers. Raise a role's effort for a task only after a run at the listed level fell short.

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
```

A task is ready when it is `todo` and every task in `depends_on` is `done`. `bun run tasks` lists all tasks, marks the ready ones with `*`, and fails on an unknown status or dependency.

Only the controller edits task files, in the main checkout, and commits each change straight to `main` (`tasks: M0.2 in_progress`). Every status change also appends a dated line to the task's log: dispatched, review verdict, merged, blocked and why. The frontmatter and the logs are the handoff, so a new controller session reads this file and runs `bun run tasks`.

Units are not files. The dispatcher plans them in its own context.

## GitHub

Dom is on the free GitHub plan, so the build uses no Actions minutes. Work happens on local branches and merges into `main` locally. Nobody opens pull requests. No workflow may trigger on `push` or `pull_request` until Dom says so; a workflow that needs adding gets `workflow_dispatch` as its only trigger. The controller pushes `main` after each merge. Task branches stay local.

## The loop

The controller keeps the loop running without waiting on Dom. While a task is ready and a dispatcher slot is free, it dispatches. It ends a turn only to wait for running agents, or when nothing can move without Dom. Status notes go in the same message as the next tool call.

1. Take the ready task with the lowest id.
2. From the main checkout: `git worktree add ../hm-wt-<id> -b task/<id>-<slug> main`. In the worktree run `bun install` and copy `apps/web/.env.local` from the main checkout. Set `status: in_progress` and `branch`.
3. Start a dispatcher with the brief: the task file path, the worktree path, the branch, and "follow the Dispatcher section of docs/workflow.md".
4. When the dispatcher reports done, set `status: review` and start a reviewer on the branch head SHA.
5. A must-fix verdict goes back to the same dispatcher through SendMessage. It fixes, commits and reports the new head. Repeat step 4; the re-review covers only the fix commits.
6. A clean verdict: in the main checkout, `git merge --no-ff task/<id>-<slug>`, run `bun run check && bun run test && bun run build`, then `git push origin main`. If a check fails, undo the unpushed merge with `git reset --hard ORIG_HEAD` and send the failure to the dispatcher. Set `status: done`, stop the dispatcher with TaskStop, remove the worktree and delete the branch.

Merge one branch at a time. A branch that is behind `main` gets `main` merged in by its dispatcher, and its checks pass again before the controller merges it.

A dispatcher that cannot finish reports blocked. Set `status: blocked` with a one-line reason and bring it to Dom if it needs a decision. When Dom says stop, start nothing new; running tasks finish to merged or blocked.

Milestone gate. Before dispatching a milestone's first task, tag `main` with `<milestone>-start` (for example `m1-start`) and push the tag. When every task in the milestone is done, start one reviewer over `git diff <milestone>-start..main`. It writes `docs/reviews/<milestone>-<n>.md` with a verdict and a findings table (severity, finding, area, resolution). Each must-fix finding becomes a new task in that milestone. After two gate rounds, open findings stay recorded in the review file and the milestone closes.

## Dispatcher

You own one task in one worktree, and the task file is the whole spec. Keep working until everything in it is done, and stop to ask only when you can't go on without the controller or Dom.

1. Read the task file. Read other docs only where the task names them.
2. Split the task into units. A unit touches one to three files, states the change, and has its own check, usually `bun test <file>`. Units that run at the same time touch disjoint files.
3. Start a worker per unit, at most 4 at once. Its brief: the worktree path, the files it may touch, the change, the check, "follow the Worker section of docs/workflow.md".
4. A unit that fails its check twice, you do yourself.
5. When the units are in, run the task's check, then `bun run check && bun run test && bun run build` from the worktree root. Done means all of them pass.
6. Commit on your branch with the task id first (`M0.2: ...`) and the Co-Authored-By trailer. Report.

When the task's scope is done and checked, stop and report. Ideas beyond the scope go at the end of the report. Review belongs to the controller, so start no reviewer agents of your own. Workers leave git to you because parallel commits in one worktree collide on the index.

A fix round applies the must-fix items, runs `bun run check && bun run test`, commits and reports the new head SHA. Bring `main` in with `git merge main`, never a rebase. Anything that needs Dom's accounts or dashboards goes in your report as a step for Dom.

A browser step in the task's check is yours: use the `agent-browser` skill with your own session name against your own dev server.

## Worker

Change only the files your brief lists, and keep working until the brief's check passes. The check must exercise the change: the test, the type-checker or the build. A syntax-only check, or a command that failed to start, doesn't count. Write logic that works for all valid inputs, not code shaped to the test's values. If the check can't pass, or a test in it looks wrong, report what fails instead of working around it. When the check passes, stop and report. The dispatcher commits.

## Reviewer

Check out the head SHA in a scratch worktree (`git worktree add --detach ../hm-review-<sha> <sha>`) and remove it when done. Review against the task file's scope and check, `CLAUDE.md`, and "Rules that are easy to break" in `docs/HANDOVER.md`. Report every finding you believe is real, minor ones included, one line each with `file:line`, marked must-fix or nit. The controller does the filtering. End with the verdict: clean when nothing is must-fix.

## Briefs and reports

- A brief points to files instead of pasting them, and adds no rules the task file lacks.
- Start agents without a `name`. Each agent delivers one report by ending its turn, without SendMessage. The controller stops an agent with TaskStop once it has the report. A dispatcher stays until its branch merges.
- Reports carry what was done, commit SHAs, checks run with results, and blockers. No code, diffs or logs. Workers write at most 5 lines and dispatchers 10. Reviewers write one line per finding plus the verdict.
- Long commands such as dev servers and builds run in the background with output to a log file. Read the tail when they finish.
- Stop processes only by the PIDs you started.

## Checks

`bun run check` runs Ultracite and typecheck. `bun run test` and `bun run build` run through turbo. `bun run dev` is pinned to port 3000, so a worktree that needs a dev server runs `bunx wrangler d1 migrations apply DB --local && bunx vite dev --port <free port>` in `apps/web`.
