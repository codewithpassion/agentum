# Ariadne analysis

Repo: `/home/roboto/devel/ariadne` (github.com/codewithpassion/ariadne). Read on 2026-10-16 at main `4b16422`. Read-only; nothing was built or run.

## 1. Purpose

Ariadne is a "software factory". Machines register as runners, git repos become projects inside a workspace, and issues walk a staged, gated workflow (coordinate, analyse, plan, build, review, deliver) run by coding agents (Claude Code, Codex, Cursor). Humans approve at gates, in the web UI, in Slack or from Claude over MCP. It is the seventh attempt at this idea and the first one with a real runner story. Its domain is pull requests, not general agents, but its plumbing (runner fleet, job queue, MCP server, Slack, tenancy) is the closest match to Harbourmaster's "always-on machine connected to the server" runtime.

## 2. Stack and deployment

- **Language and runtime:** TypeScript on Bun. Turborepo monorepo with Bun workspaces. Biome via Ultracite, same as Harbourmaster's `.claude/CLAUDE.md`.
- **Control plane:** `apps/web`. A single Cloudflare Worker (`src/server.ts`) with Hono as the top-level `fetch`, TanStack Start for SSR and UI, shadcn/ui. Same boilerplate lineage as Harbourmaster (`#/` import alias, `components/ui/` rules).
- **Cloudflare bindings** (`apps/web/wrangler.jsonc`): D1 `DB` (drizzle, migrations in `packages/db/migrations`, 47 migrations, 0000 to `0046_concierge.sql`), KV `OAUTH_KV`, R2 `ARTIFACTS`, three Durable Objects (`RunnerRelay`, `RunRoom`, `Concierge`), crons every minute (outbox drain) and daily (price sync, OAuth purge).
- **Custom domain:** `ariadne.rockyshoreslabs.io`.
- **Auth:** Clerk. Organizations map one to one to workspaces; users and memberships are projected into D1 by webhook plus a fallback sync. MCP uses `@cloudflare/workers-oauth-provider` (OAuth with Client ID Metadata Documents, no dynamic registration) plus API keys. Runners use a bearer credential. The CLI uses a device-code style login.
- **Runner:** `apps/runner`, one compiled Bun binary (`ariadne`, version 0.3.0) that is both the runner and the CLI. Released to R2 with a `runner/latest.json` manifest (`docs/releasing.md`, `apps/runner/scripts/release.ts`). Installs as a systemd user unit. Linux x64 only (see Gotchas).
- **Models:** harnesses are the Claude Code, Codex and Cursor CLIs on the runner. The Slack "concierge" calls Anthropic directly with `@anthropic-ai/sdk` from a Durable Object.

## 3. Module map

| path | responsibility | notes |
| --- | --- | --- |
| `apps/web/src/server.ts`, `worker.ts` | Worker entry, Hono, routes `/api`, `/install`, `/oauth`, `/runner`, `/mcp`, DO exports, `scheduled` | `worker.ts` wraps everything in the OAuth provider |
| `apps/web/src/api/` | All REST routes and domain logic as plain functions over a `Db` (about 100 files) | `run-loop.ts` (150K) is the run state machine driver; `jobs-queue.ts` the lease queue |
| `apps/web/src/relay/runner-relay.ts` | `RunnerRelay` DO: one hibernating WebSocket per runner, presence, offers jobs, forwards frames | logic split into testable files (`runner-presence.ts`, `job-relay.ts`) |
| `apps/web/src/relay/run-room*.ts`, `run-thread*.ts` | `RunRoom` DO: one per run, fans D1 changes out to browsers and reconciles the run's Slack thread on its alarm | read-only toward browsers |
| `apps/web/src/mcp/` | MCP server at `/mcp`: `provider.ts` (OAuth), `principal.ts`, `server.ts`, `tool.ts`, `tools/*` (26 tools) | stateless, one server per request |
| `apps/web/src/concierge/` | Slack "concierge": an Anthropic tool loop in a DO, with an inbox, catalogue of allowed tools and confirm cards | `turn.ts`, `catalogue.ts`, `inbox.ts`, `slack-outlet.ts` |
| `apps/web/src/components/`, `routes/` | UI: run page, steer box, setup, Flow page, settings | |
| `apps/runner/src/main.ts`, `client.ts` | CLI dispatcher; outbound WebSocket client with backoff, ping, close-code handling | sockets and timers injected |
| `apps/runner/src/jobs.ts` (96K) | Job loop: claim, worktree, harness run, heartbeat, guards, complete | |
| `apps/runner/src/harness/` | Adapter interface plus Claude Code, Codex, Cursor adapters, detection, event normalisers, fake harness | |
| `apps/runner/src/mcp/` | `ariadne mcp`: stdio tool server the agent spawns, with `submit_result` and `ask`; talks to the runner through files in a per-job dir | |
| `apps/runner/src/stages/` | Deterministic stages: quality checks, delivery (commit, push, PR via `gh`), protected-path guards | |
| `apps/runner/src/worktrees.ts`, `managed-checkout.ts`, `scratch-clone.ts` | Git worktree per job; runner-owned clones on request | |
| `apps/runner/src/live-session.ts`, `session-registry.ts` | Steering a running session; kept sessions for resume (`sessions.json`) | |
| `apps/runner/src/masker.ts`, `transcript.ts` | Secret masking on everything leaving the box; NDJSON transcript upload | |
| `apps/runner/src/install-service.ts`, `enroll.ts` | systemd user unit; enrollment JSON into config | |
| `apps/runner/src/cli/`, `init/` | `login`, `init`, `issue`, `run`, `status`, `answer`, `secret`; skills and managed CLAUDE.md block installer | |
| `packages/protocol` | zod wire frames: runner hello/ping, `job.*`, run room, checkouts, activity, redaction | both sides parse with the same schemas |
| `packages/contract` | Per-role result envelopes (zod to JSON Schema), artifact paths, project profile | |
| `packages/workflow` | Workflow as validated data, pure walker | ported from automaton |
| `packages/domain` | Transition tables for issues, runs, jobs; stage budgets; model prices; harness env policy | pure |
| `packages/db` | Drizzle schema (about 40 tables), migrations, in-memory D1 test harness `test-d1.ts` | |
| `packages/slack` | Pure Slack: manifest, signature check, Block Kit builders, event and intake parsers | no network calls |
| `packages/linear` | Pure Linear: webhook verify, GraphQL client, OAuth, agent-session types | |
| `docs/` | Vocabulary, dated decisions, milestone plans (very detailed), sources reviews, `system-map/index.html`, `handbook/index.html` | `docs/sources/local-*.md` records where code was lifted from |

## 4. Reusable pieces

Fit is high for most rows because Harbourmaster's boilerplate is the same Hono, TanStack Start, Clerk, D1, Drizzle, Workers stack.

| what | exact paths | copy or borrow | effort and fit | brief section |
| --- | --- | --- | --- | --- |
| Runner enrollment: 15 minute single-use token, `curl \| bash` install script, long-lived hashed credential, rotate and revoke | `apps/web/src/api/runner-enrollment.ts`, `install-script.ts`, `install.ts`, `runners.ts`, `credential-crypto.ts`, `apps/runner/src/enroll.ts`, `install-service.ts` | copy | Low effort. Replace systemd-only with launchd if Macs matter. Drop `workspaceId` handling only if single-tenant | Creating and running agents (always-on machine) |
| Runner connection: outbound WebSocket to a hibernating DO, bearer header, close 4401 means stop and 1012 means replaced, ping with alarm-based offline detection, jittered backoff | `apps/web/src/api/runner-connect.ts`, `relay/runner-relay.ts`, `runner-presence.ts`, `relay-protocol.ts`, `packages/protocol/src/runner-frames.ts`, `apps/runner/src/client.ts`, `backoff.ts` | copy | Low to medium. Strip job frames first if the first cut only needs presence. Refusals are WS closes, never HTTP statuses, on purpose | Creating and running agents |
| Job queue with leases: atomic claim as one D1 batch with lease PK as mutex, heartbeat, expiry reaper, cancel on heartbeat | `apps/web/src/api/jobs-queue.ts`, `relay/job-relay.ts`, `packages/protocol/src/job-frames.ts`, `packages/domain/src/job-transitions.ts`, `packages/db/src/schema/job*.ts` | copy | Medium. Job here means a coding stage; generalise to "run an agent turn" | Creating and running agents |
| Harness adapter interface with capabilities (interrupt, liveInput, resume, retract, structuredOutput), plus Claude Code adapter | `apps/runner/src/harness/adapter.ts`, `claude-code.ts`, `claude-session.ts`, `child.ts`, `normalize.ts`, `registry.ts`, `detect.ts` | copy | Medium. The native launch to start from: `--print --output-format stream-json --input-format stream-json --strict-mcp-config --resume --max-budget-usd --json-schema`. Tested against fakes in `apps/runner/fixtures/` | Creating and running agents, Talking to agents |
| Env filtering for the agent child: allow list, deny pattern, secrets injected after the filter, process-group kill, timeouts | `packages/domain/src/harness-env.ts`, `apps/runner/src/harness/claude-code.ts` (`buildHarnessEnv`), `stages/spawn.ts` | copy | Low | MCP connectors and credentials |
| Secret masking on all outbound text | `apps/runner/src/masker.ts`, `packages/protocol/src/redact.ts` | copy | Low. Both raw and JSON-encoded needles, longest first | Credentials, Logging |
| Job secrets: encrypted at rest (AES-GCM, `v1:` prefix), set-and-never-read, scoped to workspace or project and to stages, injected once at claim | `apps/web/src/api/secrets.ts`, `slack-crypto.ts`, `packages/db/src/schema/secret.ts`, `apps/runner/src/cli/secret.ts` | copy | Low to medium. This is the nearest thing to the brief's vault, but env-var only | Credentials (vault) |
| Live steering: queue or interrupt messages into a running session, pause, kept sessions for resume, an `ask` tool that blocks until a person answers | `apps/runner/src/live-session.ts`, `session-registry.ts`, `mcp/server.ts`, `mcp/job-dir.ts`, `apps/web/src/api/run-steer.ts`, `run-questions.ts`, `run-answers.ts`, `live-jobs.ts` | borrow the pattern | Medium to high. Tightly bound to stages and the job dir. The files-in-a-dir protocol between runner and tool server has no socket or port, so it ports easily | Talking to agents |
| MCP server on Workers: OAuth with CIMD, API keys via `resolveExternalToken`, stateless handler per request, principal types, tool registry reused by Slack | `apps/web/src/mcp/provider.ts`, `principal.ts`, `server.ts`, `tool.ts`, `apps/web/src/api/cli-tokens.ts`, `oauth-authorize.ts` | copy | Low to medium. This is exactly "connect Claude to the platform". Tools to rewrite: `tools/*` | Talking to agents |
| Slack signature check, Block Kit gate and run-card builders, event parsing, intake grammar | `packages/slack/src/*` | copy | Low. Pure, 14 test files. Manifest is Ariadne-specific | Slack, triggers, gateways |
| Slack inbound and per-run threads: events and interactions routes, user mapping by email, channel mappings, run thread reconciled on a DO alarm, streamed card | `apps/web/src/api/slack-inbound.ts`, `slack-answer.ts`, `slack-link.ts`, `slack-channels.ts`, `slack-webapi.ts`, `relay/run-thread.ts`, `run-thread-posts.ts` | borrow the pattern | Medium to high. Large and entangled with runs. Reconcile-from-D1 on an alarm is the idea worth keeping | Slack, triggers |
| Concierge: an Anthropic tool loop inside a Durable Object, one inbox per Slack thread, append-only conversation, tool catalogue limited by class, confirm cards for writes, daily spend cap, prompt-injection fencing | `apps/web/src/concierge/*`, `api/confirm-cards.ts`, `api/concierge-settings.ts` | borrow the pattern | High. Shape of "an agent you message in Slack" that runs in Cloudflare. Not yet reviewed in production | Creating and running agents (Cloudflare agent), Slack |
| Operator-app connect for an integration: one OAuth app owned by the operator, three env values, per-workspace connect is one button | `apps/web/src/api/linear-operator-app.ts`, `linear-oauth.ts`, `linear-installation.ts` | borrow the pattern | Low. This is the shape to copy for the brief's "few clicks Slack install". Ariadne's Slack does not have it (see section 5) | Slack, triggers |
| Linear agent integration (installed as an agent, mirrors transcript, answers mentions) | `apps/web/src/api/linear-agent-*.ts`, `packages/linear` | skip unless Linear matters | High effort, not in the brief | none |
| Integration outbox: enqueue in the same D1 batch as the change, drained by cron with backoff and a dead state | `apps/web/src/api/outbox.ts`, `outbox-enqueue.ts`, `packages/db/src/schema/integration-outbox.ts` | copy | Low | Slack, triggers; Logging |
| Tenancy: Clerk org to workspace projection, ordered by event time, plus membership sync fallback and the tenant gate under `/api/w/:workspaceSlug` | `apps/web/src/api/clerk-projection.ts`, `clerk-webhook.ts`, `clerk-memberships.ts`, `require-workspace.ts`, `workspaces.ts` | copy | Low. Hono merges mount and route params; they hit the `:slug` collision and named it `:workspaceSlug` | Auth and permissions |
| CLI device-code login | `apps/web/src/api/cli-login.ts`, `cli-auth.ts`, `apps/runner/src/cli/login.ts` | copy | Low | Auth |
| Run room: DO fans out D1 changes to browsers by cursor, hibernating, read-only | `apps/web/src/relay/run-room*.ts`, `packages/protocol/src/run-room-frames.ts`, `use-run-activity.ts` | copy | Medium. Works as the live view for any agent session | Talking to agents |
| In-memory D1 test harness | `packages/db/src/test-d1.ts`, `apps/web/tests/` | copy | Low. Lets `bun test` hit real SQL without wrangler | all |
| Workflow as data and pure walker; envelopes per role | `packages/workflow`, `packages/contract` | skip unless pipelines are wanted | Not needed for open-ended agents | none |
| Skills and managed CLAUDE.md block installer, checksum-marked so edits are kept | `apps/runner/src/init/skills.ts`, `managed-block.ts`, `project-file.ts` | borrow the pattern | Low | Creating and running agents |

## 5. Brief coverage

**Creating and running agents: partly.**
- Solved: a remote always-on machine connected to the server (see rows above), several harnesses chosen per workflow entry, per-job budget (`--max-budget-usd`), model chosen per entry, native launch with a filtered env in a git worktree, `max_concurrency` seats per runner enforced from the DB column and not from what the runner says.
- Container launch: nothing. `ENVIRONMENT_KINDS = ["directory", "container"]` in `packages/protocol/src/runner-frames.ts` is the only trace. The runner reports `environmentKinds: ["directory"]` (`apps/runner/src/client.ts:304`). `decisions.md` calls containers the eventual default and `milestone-7.md` puts them out of scope. There is no Docker or Podman code.
- One machine, several agents: only partly. Many jobs run side by side, each in its own worktree under a mapped project. One runner belongs to one workspace and runs as one OS user (config in `~/.config/ariadne`, one systemd user unit). Separate agents under separate user accounts means separate installs.
- "Agent" here is a role on a harness for one stage, not a long-lived named agent like Bruce. There is no UI to create an agent; roles are prompts in `apps/runner/prompts/*.md` and workflow entries.
- Cloudflare-hosted or managed-agents runtimes: only the concierge, which is a fixed Slack assistant. No generic way to create one.
- Claude Desktop-style local frontend: nothing. The CLI plus the web app is the nearest.

**Talking to agents: partly, well for live steering.**
- Solved: an MCP server so Claude can drive it (26 tools, `apps/web/src/mcp/tools/`), steer or pause a running agent, answer an agent's question (`ask` tool), per-run live page, Slack thread per run.
- Sessions stored: transcript NDJSON uploaded to R2 at `transcripts/<jobId>.ndjson` (`runner-connect.ts:271`), normalised events in the D1 `events` table, `jobs.session_ref` for harness resume, runner-side `sessions.json` kept 14 days.
- Nothing for an agent reading its own or another agent's old sessions. Nothing like an agent-to-agent inbox or forum. `concierge/inbox.ts` is only the Slack concierge's queue of pending messages per thread.

**MCP connectors and credentials: mostly nothing.**
- No connector registry, no assigning connectors to agents, no OAuth for external connectors, no re-auth trigger. The agent is started with `--strict-mcp-config` and only the ariadne tool server (`mcp/harness-config.ts`), so user MCP servers are deliberately off.
- Solved in part: job secrets (workspace or project scope, per stage, encrypted, masked, injected as env vars). Three principal kinds (`mcp/principal.ts`): OAuth (the person across all their workspaces), API key (the person in one workspace), Slack (a linked member). These record who acted, which is the first of the brief's three credential cases for Ariadne's own actions, but nothing carries a person's credentials into an external system. Per-requester credential switching and agent-owned credentials do not exist. GitHub access uses the runner's own `gh` or git login.

**Slack, triggers, gateways: partly.**
- Solved: Slack app manifest, signed events and interactions, DMs and mentions, thread follow-ups, buttons for gates and questions, channel to project mappings, per-run thread with a streamed card, email-based user linking (`packages/slack`, `apps/web/src/api/slack-*.ts`).
- Slack install is paste-token, not guided. I grepped for `oauth.v2.access` and `slack.com/oauth` in `apps/web/src` and `packages/slack/src`: no hits. The owner creates the app from the manifest by hand, then pastes the bot token and signing secret on the settings page (`slack-installation.ts`). The few-clicks install in the brief is not solved. Linear has the one-button operator-app pattern that Slack lacks.
- Triggers: webhooks from GitHub, Linear and Slack, cron for the outbox and price sync, an MCP API key. No generic bearer-token "trigger an agent" endpoint, no routines for agents, no "monitor a channel proactively".
- Linear is the only other gateway. It connects by OAuth, through the operator's app or a per-workspace app. Webhooks are checked with an HMAC over the raw body plus a payload timestamp (`packages/linear/src/webhooks.ts`). States map by Linear state `type`, not by name, so no per-team config. Writes to Linear go through the outbox. Ariadne also installs as a Linear agent and mirrors a run's transcript into the agent session (`apps/web/src/api/linear-agent-*.ts`).

**Files: nothing.** Only per-issue artifacts (plan, review documents) stored in R2 and in the repo under `docs/ariadne/<issueKey>/`. No Drive, no uploads from Slack, no file-landed triggers.

**Logging and knowledge: partly for logging, nothing for knowledge.**
- Logging: the `events` table with bounded `EVENT_KINDS` (`packages/protocol/src/job-frames.ts`) and the `approvals` table with an `actorSource`. I found no `update(events)` or `delete(events)` in `apps/web/src`, so it behaves append-only in practice, but no constraint enforces it. Secret writes are audited by name, never by value.
- Knowledge or wiki: none. The repo's own `docs/` is a good model for dated decisions and a vocabulary file, but it is for the humans building Ariadne.

**Auth and permissions: mostly solved, with more than the brief wants.**
- Clerk orgs as tenants, owner and member roles, an optional "operator" who may start and steer (`api/operator.ts`), grants binding runners to projects, tenant gate returning 404 for foreign workspaces. All customer rows carry `workspace_id`.
- This is multi-tenant from day one by decision (`decisions.md`, 2026-09-08). Harbourmaster says to keep permissions minimal at first. The tenant scoping is worth keeping; grants and operator rules can be left out.

## 6. Gotchas and lessons

From `PROGRESS.md` "Avoid next time" notes, `decisions.md` and the code.

- **Refuse in the WebSocket, not in HTTP.** A client that asked for an upgrade and got 401 cannot read the status, so it retries a dead credential forever. Ariadne accepts the upgrade and closes with 4401 (`runner-connect.ts`). A second connection closes the first with 1012.
- **Hibernating DOs lose memory.** Presence, offered-job sets and identity live in DO storage, and identity arrives in headers because a DO cannot read the name it was reached by. The relay also writes workspace and runner ids on every D1 write (a bug in the remotely relay they lifted from).
- **The relay is transport only.** Claim, heartbeat and completion are compare-and-set writes in D1. State that must survive a DO eviction or double alarm lives in D1.
- **Strict zod on the wire breaks old runners.** `harnessReportSchema`, `runnerCapabilitiesSchema` and offers are `strictObject`, so every new field needs a capability flag in `hello` and the server must not send new frames to a runner that did not announce support (`liveInput`, `managedCheckouts`). No Worker rollback below a phase while a newer runner is connected.
- **Tool-server protocol by files.** Runner and `ariadne mcp` talk through `result.json`, `questions.json`, `answers.json` in a mode 700 job dir. Cursor and Codex agents have a shell and can write `result.json` themselves, so the runner re-validates every read.
- **Test fakes must not copy the code under test.** Two incidents recorded: the Codex fake's schema check and Cursor's env interpolation. Prove such behaviour with a live probe.
- **Drizzle** reads a left-joined table as absent when its first alphabetical column is null. Select columns explicitly.
- **A stuck clone blocked setup forever.** Fixed by a 12 minute staleness rule. A managed checkout of a repo another project already uses registers a second GitHub webhook; no `remove-project` command yet.
- **Webhook ordering.** Clerk and Svix retry out of order, so every projection write carries the event time and the upsert's `setWhere` compares it.
- **Slack moves.** Since 30 June 2026 new apps are agent-view only (`features.agent_view`, `agents.sessions.setStatus`); the README in `packages/slack` records the changed events.
- **Linux only.** `install-service.ts` logs "launchd is not supported yet" on macOS. Any macOS runner needs a launchd unit first.
- **Deploy order.** `release && deploy` through a pipe once released a runner before its Worker (0.1.12).
- **Browser testing needs HTTPS.** The Chrome that automation drives is on another machine, so they serve the dev server over Tailscale HTTPS. Harbourmaster's dev login note already matches.
- **Pre-commit hook** runs `ultracite fix` over the whole tree, so a red tree rewrites unrelated files.
- **Docs and code disagree in places.**
  - `CLAUDE.md` says phase 3 is current, but main contains phase 4 (concierge and run threads, at least 20 commits on 2026-10-12).
  - `docs/milestone-7-phase-4.md` still says "built on branch `m7-phase-4`, not reviewed or deployed", yet main carries its review fixes.
  - `PROGRESS.md` ends at cycle 26 (phase 3).
  - `docs/releasing.md` has leftover "do not bump by hand" text.
  - `packages/*/README.md` still describe lift tables and "phase 2" states that the code has moved past.
- **Design smell:** `run-loop.ts` is 150K, `jobs.ts` (runner) 96K, `slack-answer.ts` 67K, `linear-agent-outbound.ts` 66K, `github-fixes.ts` 57K. These mix many concerns and are poor copy sources. Copy the small, pure files.
- **History caveat:** `git rev-list --count HEAD` gives 768 commits, but the earliest commit date is 2026-10-11 while `PROGRESS.md` dates cycles from 2026-09-08. The dates in git were probably rewritten or imported, so use the docs for chronology.

## 7. Maturity

- **Last commit:** 2026-10-12 (`4b16422`). 768 commits on one branch, plus leftover `ariadne/job-*` branches and two worktrees in `.claude/worktrees/`.
- **Tests:** yes, heavy. About 322 test files; the last recorded run in PROGRESS (cycle 26) is `bun test` 2909 passing and `bun run check` green. I did not run them. Includes protocol frames, queue and lease logic against in-memory D1, adapters against fake harness scripts, Slack and Linear parsers.
- **Deployed:** yes, to `ariadne.rockyshoreslabs.io` on Cloudflare, with real runners ("Morosini" runner at 0.3.0) and live checks recorded through phase 3. Evidence that production lags main: the Ariadne MCP connector in this session lists 25 tools and lacks `list_open_work`, which `apps/web/src/mcp/server.ts` registers. So production is at phase 3 and phase 4 (concierge, Slack run threads) is merged but not live. Treat the concierge as untested against real Slack and Anthropic (the phase doc says probes 1 to 4 and 6 had not run).
- **Completeness:** the pull-request factory loop works end to end: runner install, job lease, three harnesses, gates, Slack, Linear, MCP, GitHub. Missing against the Harbourmaster brief: containers, agent creation UI, connectors and per-user credentials, files, wiki, inbox, generic triggers, guided Slack install, non-Linux runners. Production runs on a Clerk development instance (open item 15 in `milestone-7.md`).
- **Single operator in practice:** one person has driven every live check.
