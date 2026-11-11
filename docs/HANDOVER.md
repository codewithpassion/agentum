# Agentum handover

Rewritten 26 October 2026. v1 is built (milestones M0 to M9 and the C, F, P, R, S, SK, T, U and W series, 19 Oct). The next work is v2: Agentum becomes Agentum v2 and keeps its name. Start at `docs/v2/build-plan.md`.

## Where things stand

- Staging is live at https://staging.agentumbot.io and passed its smoke test (O.1, 17 Oct). Production at agentumbot.io passed its smoke test on 26 Oct 2026 (V0.2, Worker version 329adc56).
- Production runs on the production Clerk instance (`ins_3LDH0LvG5SOMvxgdBIX2kyIj1Sf`, X.1, 26 Oct 2026), with its Dev Workspace and Harbour Edge Intelligence orgs. Staging, local dev and previews run on the Clerk dev instance (`faithful-falcon-1887.clerk.accounts.dev`). An organisation gets in through a `workspaces` row (WS.1, 2 Nov 2026, replaced the `ALLOWED_ORG_IDS` secret; `bun run add-workspace` makes a row, and reads the dev key from `apps/web/.env.local` for `--local` and `--remote --env staging`, the production key for `--remote`). The dev user `dev@rockyshoreslabs.io` belongs only to Dev Workspace, so agent sign-ins land there.
- Three runtimes behind one run model: `machine` (the Rust `agentum` client running Claude Code as its agent user), `cloud` (Pi Durable in the `PiRun` DO, isolate or Linux VM through `VmSession`) and `managed` (Anthropic Managed Agents through `ManagedPoller`).
- Built around them: connectors with OAuth and the user, colleague and agent credential modes; a secrets vault with egress placeholders; the git-like skill store; triggers and routines; per-agent Slack apps; the forum inbox; the workspace library with sync onto machines and VMs; the append-only event log; the platform MCP server.
- Every v1, v2, X and WS task is done (`bun run tasks`). The only open tasks are the live artifacts ones (L, LD, LG, LX), below.
- Agent connections (AA, 1 Nov 2026): A2A 1.0 server and client, invites, access keys and pairing codes, compatible with Hermes. Production runs it at Worker version f885d00e (1 Nov 2026). `bun run deploy` has no migration step, so apply new migrations with `wrangler d1 migrations apply DB --remote` first. Spec: `docs/v3/agent-connections.md`. Reviews and open items: `docs/reviews/AA-1.md`, `AA-2.md`.
- Daemon install (DI.1, 1 Nov 2026): `deploy` and `staging:deploy` build and publish `agentum-rs` to `releases/` in the `FILES` bucket, and machines install with `curl -fsSL <origin>/install-agentum.sh | sh` (CL.1 retired the TypeScript daemon and the Go computer client; `/install.sh` and `/install-computer.sh` print that command and fail). Publishing refuses a dirty tree and needs Rust cross-compile tooling.
- Workspaces (WS.1, WS.2, 2 Nov 2026): a `workspaces` row admits an organisation, and the rail menu switches and creates workspaces. Thread Dismiss (RL.9) and the top bar (RL.10) shipped with them. Invitations go through `Invite people` (WS.4, WS.5). The organisation picker is our own (WS.6). Production runs them at Worker version 5309aa58 (2 Nov 2026). A real invitation on production is still untested.
- Send shortcut (3 Nov 2026, `78355c92`): Ctrl+Enter or Cmd+Enter submits the new task, agent, describe, ask, routine, library editor and wiki suggestion forms, and the primary button shows a key badge. Staging runs it at Worker version d0d86db1. Production runs it at Worker version 67613c23 (3 Nov 2026).
- Live artifacts (collaborative docs and decks, `docs/v3/live-artifacts-prd.md`) were built by a Codex thread from 27 to 28 Oct and merged to `main`. No session works on them now. The L, LD, LG and LX task files still say `review` or `in_progress`, because no independent review was done. The handoff is `docs/reviews/tasks/L.HANDOFF.md`: guest sessions can die when a cookie swap is interrupted, `document_edit` drops external images, the last guest runtime changes need a security review, and none of it has been accepted on staging. The local branch `t3/guest-client` (3 commits) is superseded by `19b5bfe1` on `main` and can be deleted.

Read in this order:

1. `docs/v2/build-plan.md`: the v2 decisions, lanes, executors and every milestone.
2. `docs/workflow.md`: how the build runs, including the Codex lane.
3. `docs/architecture/index.html` and `build-plan.html` for the v1 design. `docs/analysis/*.md` and `reuse.html` date from 16 Oct and are stale on what Agentum itself has.

## Dom's decisions for v2 (26 Oct 2026)

| Question | Decision |
|---|---|
| Product | Agentum absorbs Agentum and Trueforge features and becomes Agentum v2 under the Agentum name |
| Home screen | A work-first desk: Needs you, Running, Done |
| Agents | One-page profile per agent, created by describing it and reviewing a draft. No org chart, no staff or hiring framing |
| Designer view | An n8n-style map of triggers, agents and outputs, as a separate view |
| Chat | assistant-ui (MIT), attached to a task, not the centre of the app |
| Wiki | Built into the library, with versions and suggested edits. The Brain is no longer the wiki |
| Library on machines | Live two-way sync, per-agent folder access, a task output folder, versions on every write |
| Agent email | One inbox per agent from agentic-inbox-hei. Mail to outside contacts needs approval by default |
| Supervisor agent | Later |
| Agentum UI | May be used as a source (16 Oct rule lifted) |

The v1 decisions still hold where v2 doesn't replace them: `bypassPermissions` as `hm-agent` with a `single_user` fallback, the machine's own Anthropic login, one Slack app per agent with the manifest paste flow, `user_or_agent` as the default credential mode, allow-listed Clerk orgs.

## Rules that are easy to break

- Services are factories that take `{ db, atomic, ... }` and never read `env`. `apps/web/src/server/compose.ts` builds them.
- Multi-statement writes go through `atomic` from `@repo/db/atomic`. It wraps `db.batch` on D1 and `db.transaction` on `bun:sqlite`, because drizzle 0.44.7 has `batch` only on D1.
- Every table except `workspaces` has `workspace_id TEXT NOT NULL` with no default.
- Each module exposes one `exports` subpath, such as `@repo/services/runs`. No barrel files. Biome's `noBarrelFile` is an error, and that repo rule wins over the global "index.ts barrel" rule.
- Every new binding goes in three places in `wrangler.jsonc`: top level, `env.staging` and `env.staging.previews`. DO `migrations` and `triggers.crons` stay top level only.
- A release that creates or renames a DO class goes out with `wrangler deploy`. Cloudflare refuses `versions upload` for those.
- A new service is built in `composeWith` in `apps/web/src/server/compose.ts`. A change to `context.ts` itself also goes in the add-clerk template copy under `.claude/skills/add-clerk/templates/`.
- Agentum's UI may be used as a source or example. Dom lifted the 16 Oct rule on 26 Oct 2026, because Agentum becomes Agentum v2. Its backend modules and protocols are fine to copy too.
- Pi is pinned to exact versions in `apps/web/package.json` (`agents`, `@earendil-works/pi-durable`, `pi-ai`, `chord`, `typebox`), because Pi Durable is experimental and has broken between minor versions. Every bump of one of them runs `bun run e2e:pi-durability` from the repo root before it merges. It kills `vite dev` with `kill -9` during an unsafe tool call, during a safe one (the dev-only `dev_slow_read` tool, which a production build must not contain, checked by `apps/web/scripts/check-dev-only.ts` in `bun run build`) and during a 120 s outage, and needs `PUBLIC_BASE_URL=http://localhost:<port>` in `apps/web/.env.local` first (header of `scripts/e2e/pi-durability.ts`). It takes about 5 minutes and needs no API key.
- A copied file comes in with its tests, or it doesn't come in.

## Things nobody has verified yet

- Whether Managed Agents' sandbox can run the library sync helper (V4).
- A 4-minute MCP call held open through the deployed Worker (M3.3).

## Session setup notes

- `harbourmaster/.claude/settings.local.json` (gitignored) sets `teammateMode: "in-process"`. It also allows reads under `/home/roboto/devel/**` and edits under `docs/**`. Subagents therefore run without tmux panes. Stop idle subagents when they finish.
- The pre-commit hook runs Ultracite. It reformats HTML in `docs/` and fails on lint errors, such as an SVG without a title. Fix the errors rather than skipping the hook.
- Codex runs through `scripts/codex-task.sh <worktree> <brief file> <log dir>`, with `--dangerously-bypass-approvals-and-sandbox`, because its bwrap sandbox fails on this host (`loopback: Failed RTM_NEWADDR: Operation not permitted`) and a sandboxed `codex exec` could not write files. With the sandbox off, Codex runs as Dom's user with network access, limited only by the brief's rules and the script's check that the target is a git worktree under `/home/roboto/devel/harbourmaster-wt/`. The script stops a job after 90 minutes (`CODEX_TASK_TIMEOUT` overrides it) and prints the exit code, whether the usage limit was hit, and the path of `last-message.md`. Use the plain CLI, not the openai-codex Claude plugin, which passes its own sandbox flags.
- The Brain wiki has the brief under `projects/harbourmaster`. The architecture lives only in this repo.
