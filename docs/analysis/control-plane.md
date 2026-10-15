# Analysis: control-plane

Repo: `/home/roboto/devel/control-plane` (GitHub `codewithpassion/control-plane`, private). Read on 2026-10-16, main checkout only.

## 1. Purpose

The control plane is an ops event hub for Dom's own systems (jobs, Workers, apps, agents). It takes webhooks and heartbeats from GitHub, Sentry, PostHog, Cloudflare and cron jobs, turns them into one event envelope, groups them into incidents, and pages Slack. A Claude Haiku triage agent proposes a fix, and a human approves it in Slack before a Workflow runs the action. It is not a data collector for content sources. The brief's description ("collects data and events from different sources") is wider than the code: there is no Plaud, Granola, Drive or Slack-message connector (grep for `plaud|granola|drive|samba` finds nothing in the code or docs). Sources are ops sources only.

## 2. Stack and deployment

- Language and runtime: TypeScript on Bun (workspaces, `bun test`, 114 test files), Turborepo, Biome via Ultracite, husky.
- Same boilerplate as Harbourmaster: TanStack Start + shadcn on Cloudflare Workers, Hono, D1 + Drizzle, tRPC, Clerk. The repo was created from `codewithpassion/cf-tanstack-boilerplate`, so `/project-init`, `add-clerk`, `setup-cloudflare`, `setup-previews` skills are the same ones Harbourmaster has.
- Two Workers:
  - `apps/web` (`control-plane-web`): UI, tRPC at `/api/trpc`, MCP at `/mcp`, Slack interactivity at `/api/slack/interactivity`.
  - `apps/engine` (`control-plane-engine-{staging,production}`): ingest, consumers, router, triage, actions, heartbeats, cron.
  - Web reaches engine through a `ENGINE` service binding to the `EngineRpc` entrypoint (`apps/engine/src/rpc.ts`). Engine must deploy before web.
- Cloudflare products: D1 (shared by both Workers), Durable Objects (SQLite-backed), Queues (notify, agent-tasks, actions, each with a DLQ), Workflows (`ActionWorkflow`), R2 (`PAYLOADS`, payloads over 64 KB), Pipelines + R2 Data Catalog ("Basin", archive queried by SQL), "K2" streams (an append-only event stream with pull consumers, used as the event log), Email Service (`send_email` binding), AI Gateway (Anthropic proxy), Agents SDK (`agents` package).
- Auth: Clerk for people (`people.clerk_user_id` links Clerk users to approver/viewer roles). Machines use hashed bearer tokens `cpt_…` in `api_tokens` with space-separated scopes (`ingest:events`, `ingest:github`, `ingest:heartbeat`, `read`, `propose`, `admin`, …) and client grants. Webhook sources use per-source shared secrets or signatures (GitHub HMAC, Sentry client secret, PostHog Standard Webhooks, CF secrets).
- Hosting: Cloudflare account `a12823…` (Dom's gmail account), custom domains under `rockyshoreslabs.io`: `controlplane[-staging].…` and `controlplane-engine[-staging].…`. Deploy is `wrangler deploy` per app; CI is `.github/workflows/deploy-staging.yml` (check, test, build, migrate staging D1, deploy engine then web). PR previews via `preview.yml` + `apps/web/scripts/preview.ts`.
- External services: Slack (`chat.postMessage` over `fetch`, no SDK), Anthropic API (through AI Gateway), GitHub API (re-run workflows), Linear (open issue action), Healthchecks.io (dead-man ping).

## 3. Module map

| path | responsibility | notes |
|---|---|---|
| `packages/events/src/envelope.ts` | Zod `envelopeSchema`/`envelopeInputSchema`, `EVENT_TYPES` (25 types), `SEVERITIES` (info/warn/action/critical), `toEnvelope` | The one event shape. Strict, 128 KB cap. Sources list lives in `packages/db/src/shared.ts` (`EVENT_SOURCES`). |
| `packages/events/src/ids.ts`, `payload.ts`, `redact.ts`, `text.ts` | ULID event ids (`evt_…`), deterministic source ids (`eventIdFromSource`), 64 KB payload cap with R2 pointer (`capPayload`), `stripSecrets`, text sanitising | Pure, no bindings. |
| `packages/events/src/adapters/*` | Pure adapters per source: `github`, `sentry`, `posthog`, `cf-issues`, `cf-alerts`, `inbox`; shared `normalize.ts` (`normalizeDraft`); `harness.ts` fixture runner | Contract in `adapters/types.ts` (`Adapter<P>`, `AdapterResult`). 71 recorded fixtures in `__fixtures__/`. |
| `packages/events/src/{agent-task,action,notify,archive}.ts` | Queue message schemas (`agentTaskMessageSchema`, `actionRunMessageSchema`, notify messages), archive flattening | Versioned (`v: 1`) strict Zod messages. |
| `packages/db/src/schema.ts` | Drizzle tables: `systems`, `system_links`, `source_mappings`, `allowed_actions`, `routing_rules`, `incidents`, `proposals`, `approvals`, `timeline_events`, `people`, `api_tokens` | 6 migrations (0000 to 0005). Table modules, one per domain, no barrel. |
| `packages/services/src/*` | Service factories taking a `Database`: `systems`, `tokens`, `source-mappings`, `incidents`, `proposals`, `approvals`, `rules`, `timeline`, `history` (Basin SQL), `people`, `triage` (`buildAgentTask`), `summary` | Same pattern as Harbourmaster's CLAUDE.md. |
| `packages/api/src` | tRPC `init.ts` (public, protected, and scope/role-checked procedures), `context.ts`, routers: systems, tokens, events, incidents, proposals, approvals, rules, mappings, history, summary | Caller resolved from bearer token or Clerk-linked person. |
| `apps/engine/src/ingest/` | `pipeline.ts` (normalise, map to system, cap payload, produce to K2), `webhook.ts`, `delivery.ts`, `secrets.ts`, `standard-webhooks.ts`, `body.ts` | Shared by every webhook route. |
| `apps/engine/src/routes/` | `ingest-events.ts` (generic `POST /ingest/events`), `ingest-{github,sentry,posthog,cf-issues,cf-alerts,inbox}.ts`, `heartbeat.ts` (`POST /hb/:systemId/:phase`), `health.ts` | Hono apps built from dependency factories (`createGithubApp(deps)`). Wired in `worker-app.ts`. |
| `apps/engine/src/k2/`, `consumers/` | K2 producer wrapper, pull-loop `ConsumerLoop`, base DO `K2ConsumerDO`, `TimelineDO`, `ArchiveDO`, `RouterDO`, `registry.ts` | Each consumer is a DO with an alarm loop, restarted by the minute cron. |
| `apps/engine/src/router/` | Pure routing: `route.ts`, `rules.ts`, `state-machine.ts`, `quiet-hours.ts`, `digest.ts`, `proposals.ts`, `approvals.ts`, `enqueue-action.ts`, `ports.ts` | Incident dedupe by fingerprint, lanes (interrupt/digest/record), quiet hours 22:00 to 07:00 Sydney, daily digest. |
| `apps/engine/src/heartbeat/` | `HeartbeatDO` (one per system), `monitor.ts`, `schedule.ts` (Croner, per-system IANA tz), `state.ts` | Dead-man switch for cron jobs. |
| `apps/engine/src/notify/` | Queue consumer for Slack root/thread/feed/digest posts, `slack-render.ts`, `slack-client.ts`, `email.ts`, `proposal.ts` | Retry/backoff, rate-limit handling, claim-then-post root dedupe. |
| `apps/engine/src/triage/` | `TriageAgent` (Agents SDK DO per incident), `run.ts` (Claude loop with read-only tools), `prompt.ts`, `control-plane-client.ts`, `consumer.ts` | Agent reads via the control plane API with its own token; posts a proposal only. |
| `apps/engine/src/actions/` | `ActionWorkflow`, `run.ts`, executors `rerun-github-workflow`, `retry-job`, `open-linear-issue`, `safe-url.ts` (SSRF guard), `sweep.ts`, `registry.ts` | Approved proposal → queue → Workflow instance (id = approval id). |
| `apps/engine/src/self-monitor/`, `cron/`, `scheduled.ts` | Lag/staleness alerts, Healthchecks ping, DLQ handler, minute / quarter-hourly / 10-minute / nightly crons | |
| `apps/engine/scripts/hb-wrap.sh`, `create-token.ts` | Shell wrapper that pings start/success/fail around any cron command; token bootstrap CLI | |
| `apps/web/src/server/mcp/` | MCP server over streamable HTTP at `/mcp` (`handler.ts`, `server.ts`, `trpc-tool.ts`) | 7 tools, bearer-token only. See section 4. |
| `apps/web/src/server/slack/` | `interactivity.ts` (approve/reject/snooze/ticket buttons), `verify.ts` (signature check) | |
| `apps/web/src/routes/`, `components/control-plane/` | UI pages: incidents, incident detail, timeline, systems, rules, tokens, login | Thin operator UI. No agent management. |
| `.claude/skills/*`, `docs/workflow.md`, `docs/coordinator-templates/` | Boilerplate skills plus the "controller + delegated implementers" working process | Not product code. |

## 4. Reusable pieces

| what | exact paths | copy or borrow | effort/fit | brief section |
|---|---|---|---|---|
| Event envelope + ids + payload cap + redaction | `packages/events/src/{envelope,ids,payload,redact,text}.ts` | Copy, trim `EVENT_TYPES`/`EVENT_SOURCES` | Low effort. Strict, tested, Workers-safe. Replace the ops event types with agent-platform ones (`agent.message`, `agent.run.*`, `trigger.*`). This is the append-only log shape. | Logging and knowledge |
| Generic ingest endpoint with scoped bearer tokens | `apps/engine/src/routes/ingest-events.ts`, `ingest/pipeline.ts`, `packages/services/src/tokens.ts`, `packages/db/src/api-tokens.ts`, `apps/engine/scripts/create-token.ts` | Copy | Low-medium. Gives the "external API endpoint with bearer auth that triggers an action" trigger almost as is: hashed `cpt_` tokens, scopes, client grants, 202/400/401/403/503 contract, batch of 100. | Slack, triggers, gateways; Auth |
| Webhook adapter pattern + fixture harness + `normalizeDraft` | `packages/events/src/adapters/{types,normalize,harness}.ts`, `adapters/github.ts`, `apps/engine/src/routes/ingest-github.ts`, `ingest/{webhook,secrets,standard-webhooks}.ts` | Borrow the pattern, copy the harness and Standard Webhooks verifier | Medium. Pure `(payload, headers, now) → drafts` plus recorded fixtures is the cheapest way to add gateways (Slack events, Drive push, Plaud/Granola webhooks). The normalise step fixed a whole bug class (see section 6). | Slack, triggers, gateways; Files |
| Source mapping (external key → system) | `packages/db/src/source-mappings.ts`, `packages/services/src/source-mappings.ts`, `ingest.unmapped` event | Borrow | Low. Maps a Slack channel, Drive folder or repo to an agent. Unmapped deliveries are kept as an event rather than dropped. | Slack, triggers, gateways |
| MCP server over tRPC (streamable HTTP, bearer auth) | `apps/web/src/server/mcp/{handler,server,trpc-tool,context,auth}.ts`, `apps/web/src/server.ts` lines 85 to 93 | Copy the skeleton | Low. Each tool is a thin `appRouter.createCaller(ctx)` call, stateless transport (`sessionIdGenerator: undefined`), 64 KB body limit, tool text marks returned data as untrusted. Gives "Claude talks to the platform via MCP". No OAuth, so Claude.ai connectors need an auth layer added. | Talking to agents |
| Heartbeat monitor | `apps/engine/src/heartbeat/*`, `routes/heartbeat.ts`, `apps/engine/scripts/hb-wrap.sh` | Copy | Medium. Directly answers machine liveness: an always-on machine runs `hb-wrap.sh` or pings `/hb/:id/:phase`; the DO raises `heartbeat.missed` after slot + grace. Cron-slot logic is subtle (5 review rounds), so copy rather than rewrite. For a "machine is up" ping, a simpler interval check would do. | Creating and running agents |
| Durable event log: K2 → consumers → D1 timeline + Basin archive | `apps/engine/src/k2/*`, `consumers/{base,loop,timeline,archive,registry}.ts`, `packages/events/archive-schema.json` | Borrow the pattern; copy only if K2 and Pipelines are wanted | High risk. K2 has no local emulation and each env needs its own stream. For Harbourmaster the append-only log could be a D1 table or a DO SQLite table, with R2 for large payloads. Basin SQL history queries (`packages/services/src/history*.ts`) are the optional "learn from patterns" layer. | Logging and knowledge |
| Router: rules, lanes, incident grouping, outbox | `apps/engine/src/router/*`, `consumers/router.ts`, `packages/db/src/routing-rules.ts` | Borrow selectively | Medium-high, and too ops-specific as is. Reusable ideas: first-match routing rules stored as rows (`match_json` with `source`/`type`/`payload` dot-path matches), DO outbox drained in order, processed-id ledger. | Slack, triggers, gateways |
| Slack posting with retry, dedupe and escaping | `apps/engine/src/notify/{consumer,slack-client,slack-render}.ts`, `packages/events/src/notify.ts` | Copy | Medium. Handles 429 `Retry-After`, permanent-error detection, claim-then-post root ts, thread replies, escaping. Outbound only. | Slack, triggers, gateways |
| Slack interactivity (signed button callbacks → decision) | `apps/web/src/server/slack/{interactivity,verify}.ts`, `apps/engine/src/notify/proposal.ts`, `packages/services/src/proposal-slack.ts` | Copy | Low-medium. Signature verification and Slack-user → person mapping (`people.slack_user_id`) are the parts to keep. No Slack Events API receiver, no OAuth install flow, no thread-reply handling. | Slack, triggers, gateways; Auth |
| Agent as an Agents SDK Durable Object with a bounded Claude tool loop | `apps/engine/src/triage/{agent,run,prompt,control-plane-client}.ts`, `consumer.ts` | Borrow | Medium. Pattern: queue message → DO per incident → Claude Messages API via AI Gateway with read-only tools, 8 tool calls, 2-minute cap, state in DO, tools call the platform API with the agent's own scoped token. This is the "Cloudflare agent" runtime option in miniature. | Creating and running agents |
| Propose → approve → run action (human-in-the-loop) | `packages/db/src/schema.ts` (`proposals`, `approvals`, `allowed_actions`), `apps/engine/src/actions/*`, `router/{proposals,approvals,enqueue-action}.ts` | Borrow | Medium. An allow-list of action types per system plus a Workflow per approval (id = approval id, so re-sends cannot double-run). Fits the "agent credentials" case and approval gates later. | Auth and permissions |
| `safe-url.ts` SSRF guard for outbound fetches | `apps/engine/src/actions/safe-url.ts` | Copy | Low. Useful for any connector or health checker that fetches user-supplied URLs. | MCP connectors and credentials |
| Staging and PR-preview deploy with D1 migrations | `.github/workflows/{deploy-staging,preview}.yml`, `apps/web/scripts/preview.ts`, `.claude/skills/setup-previews` | Already in Harbourmaster | None. Harbourmaster has the same boilerplate. Only the engine-before-web ordering and two-Worker split are new. | (platform) |
| Dev login, Clerk → `people` link, scoped procedures | `apps/web/src/server/trpc/{context,pick-caller}.ts`, `packages/api/src/init.ts`, `packages/db/src/people.ts` | Borrow | Low. `ctx.caller` = bearer token or Clerk-linked person, same scope checks for both. Better than Harbourmaster's current `userId`-only context once agents hold tokens. | Auth and permissions |

## 5. Brief coverage

- Creating and running agents: partly, and only in miniature.
  - No agent registry, no create-agent UI, no runtime choice, no machine/container/user-account model.
  - `systems` has `kind` (`job|worker|app|agent|inbox`) and `runs_on` (`cloudflare|hetzner|home-box`), but these only label what is being monitored. Nothing starts or places a process.
  - The one running agent is `TriageAgent` (Agents SDK DO). Heartbeats cover "is the machine or job alive".
- Talking to agents: partly.
  - `/mcp` lets Claude read systems, events, incidents, deploys, history and create a proposal (`propose_action`). It does not message an agent.
  - No stored sessions (triage keeps a per-incident DO state record only). No agent-to-agent inbox. The `inbox` source is something else: an "agentic inbox" Worker (email-style) that posts notifications in (`POST /ingest/inbox`).
- MCP connectors and credentials: nothing.
  - The repo exposes one MCP server. It does not manage outbound connectors, OAuth, vaults or per-user credentials.
  - Per-source webhook secrets are Worker secrets. Third-party tokens used by actions (`GITHUB_ACTIONS_TOKEN`, `LINEAR_API_KEY`) are plain Worker secrets.
- Slack, triggers, gateways: partly (outbound strong, inbound weak).
  - Triggers: bearer-token HTTP ingest and cron exist (heartbeat, quarter-hourly, digest). A matched event can queue an agent task (`AGENT_TASKS`) when `TRIAGE_ENABLED`.
  - Slack: outbound posts and signed button callbacks only. No Slack install/OAuth, no message events, no "tag the agent in a thread", no channel monitoring. Routing rules are rows edited through `rules.upsert`, so a user-defined "event → agent" mapping is feasible.
  - Event-driven wake-up of an agent is demonstrated end to end: router → `AGENT_TASKS` queue → `handleAgentTasks` → `TriageAgent` DO.
- Files: nothing.
  - No Drive, Meet, Samba or file-landing trigger. Large payloads go to R2 with a pointer (`payload_ref`), which is event payload storage, not file exchange.
- Logging and knowledge: logging solved, knowledge nothing.
  - Every event is an immutable envelope on a K2 stream, copied to D1 `timeline_events` (30-day trim) and to an Iceberg archive queryable with SQL (`history.query`). Incident changes are also events (`incident.opened/updated/resolved`, with `seq` so gaps are visible).
  - No wiki or file-based knowledge base.
- Auth and permissions: mostly solved for a first iteration.
  - Clerk sign-in, people with approver/viewer roles, hashed scoped tokens with client grants, admin tokens only from a bootstrap script, token subset rule on minting (`mintableScopes`).
  - `client_id` on every row and token is a multi-tenant hook ("keep fine-grained permissions in mind"). Today every client resolves to `hei`.
  - Credentials for acting as a user or colleague: nothing.

## 6. Gotchas and lessons

From `PROGRESS.md`, `docs/HANDOVER.md` and the code:

- Heartbeat slot attribution took 5 review rounds. A round-4 fix caused daily false pages and was reverted. Start pings are what tie a run to a slot. A cron job that finishes late can delay detection by one slot.
- Webhook adapters kept failing the same way: an untrusted value passed the adapter and failed envelope validation. The fix was one shared `normalizeDraft` plus a fuzz test (`packages/events/src/adapters/normalize.fuzz.test.ts`). Keep new adapters on that path. That test also timed out on CI (HEI-561) and needed `setDefaultTimeout`.
- D1 caps a statement at 100 bound parameters; `bun:sqlite` tests do not. Size batches for D1 and assert the parameter count in tests.
- Pipelines rejects requests over 5 MB. Chunk by bytes, not record count. Archive redelivery duplicates rows; dedupe by `id` with `QUALIFY ROW_NUMBER()`.
- K2 has no local emulation. Top-level wrangler config binds a real dev stream; staging and production must each name their stream. K2 consume tokens cannot be scoped to one stream.
- K2 error 10212 means the append outcome is unknown, so the ingest route answers 502 and the sender's retry may duplicate.
- Bindings are not inherited between wrangler envs. Previews need bindings in `env.staging.previews` too.
- Engine must deploy before web, and root `bun run deploy` (turbo) runs them in parallel, so the first production deploy is done by hand.
- The turbo cache hid a cross-package type break; `typecheck` now depends on `^typecheck`, and `verify` passes `--force`.
- A same-account Worker-to-Worker `fetch` over a custom domain failed fast with `request_error` (harbouredgetraining heartbeats, 2026-10-11). Suspected cause: should use a service binding. Not confirmed (HEI-115 open).
- Router loop guard: events the router itself emits (`incident.*`, `action.*`, `approval.*`, `agent.proposal`) are skipped, and ingest rejects those types from outside (`own-output.ts`, commit 444ad62). The `control-plane` system is never triaged. A system that watches itself needs this.
- Router drops events older than 60 minutes (replay protection after a first start). A router outage over an hour loses real alerts, so the lag alert has to fire first.
- Each incident attach emits an `incident.updated` event, so 1000 identical errors make 1000 events. Accepted for now.
- Slack: thread replies do not show in the channel view, which tripped browser checks. A rare duplicate root post is possible when Slack accepts a post but the response is lost.
- Quiet hours (22:00 to 07:00 Sydney) hold anything below critical, which hid live-test alerts at night.
- Triage first-open of an incident queued no task, a reopen did (HEI-566, backlog).
- Process lessons: `codex exec` hangs unless stdin is `/dev/null`; the Codex plugin's bwrap sandbox does not work on the host; watch PIDs, never `pgrep -f`; fix rounds add regressions, so re-review each one.
- Secrets hygiene: `docs/HANDOVER.md` lists local secret file names and one note that an agent printed `LINKEDIN_SYNC_API_KEY` into session transcripts. Agents that read SKILL.md instructions can leak keys into logs.

Docs vs code:
- `docs/HANDOVER.md` top table says M4 to M6 "Not started"; its last section and the git log show M6 (triage, approvals, actions) built and live on staging.
- `apps/engine/README.md` says triage and approval transitions "have tests but no callers until M6" and `NOTIFY_ENABLED` is false "until Lane B is live". Staging now has both `NOTIFY_ENABLED` and `TRIAGE_ENABLED` true; top level and production still `false`.
- `CLAUDE.md` mentions `@repo/db/systems "once it exists"`; it exists. `README.md` still carries boilerplate instructions (template URL, `/project-init`) next to the real two-Worker deploy.
- `packages/api/README.md` says `userId` stays null until Clerk is added; Clerk is wired.
- The brief's list (Plaud, Granola, Slack, Drive) does not match the repo. Those are Dom's MCP tools in his Claude session, not control-plane connectors.

## 7. Maturity

- Last commit: Mon 12 Oct 2026 05:08 +1100 (`d61532e`). 50 commits, first on 4 Oct 2026, so the whole repo is about 8 days old.
- Tests: yes. 114 `*.test.ts` files across engine, events, db, services, api, web. Adapters have recorded fixtures plus a fuzz test. Tests run on `bun:sqlite` with injected clock, R2 and K2 fakes (`apps/engine/src/k2/fake.ts`). CI runs check + test before deploy.
- Deployed: staging only (web + engine, CI deploys on push to `main`). Production D1, K2, R2 and Basin resources exist, but production Workers are not deployed (per HANDOVER; production D1 at migration 0002 at the time of writing). The home-box crontab and one production Worker report heartbeats to staging.
- Completeness:
  - Built and working on staging: ingest for six sources, heartbeats, timeline, archive, router, Slack notify, email, daily digest, triage proposals, approval buttons, three action executors.
  - Partly verified: Slack approval-to-action path was mid-test at the last handover; Sentry, PostHog and live CF alert deliveries are not configured; fine-grained GitHub PAT and key rotations pending.
  - Heavy use of Cloudflare beta products (K2, Pipelines/Basin, Worker Previews, Email Service), which raises the cost of copying it wholesale.
  - Single operator in practice (one person, one Slack workspace, `hei` client, Sydney time hard-coded in digest and quiet hours).
