# Progress Log

A reverse-chronological log of implementation cycles in this project — what was
done, what went wrong, and what to avoid next time. Newest entry first.

---

## Cycle 16 — Cloudflare runtime: agents without Managed Agents (2026-09-01)

**Goal:** A way to run an agent without Claude Managed Agents — directly on Cloudflare, on a model hosted on Workers AI or reached through AI Gateway — chosen per agent at creation.

**What we did:**
- `agents.runtime` (`managed` | `cloudflare`, migration 0021), fixed at creation: the API refuses a change, the dialog offers the choice only for a new agent. A Cloudflare agent is `synced` the moment its row exists (nothing to register), and the rail reads that as "runs on Cloudflare"
- `modules/runner`: an `AgentRunner` Durable Object per agent holds the session transcript and advances it from `alarm()` — a few steps per invocation, then re-arm, so `send`/`stop` land between steps and a dead host resumes from the transcript (`step.ts` is a pure state machine over the last message: assistant-with-tool-calls → run tools, assistant → idle unless text arrived meanwhile, else ask the model; partial tool results are persisted per call so a resume never re-posts)
- Models via the `AI` binding: `@cf/...` runs on Workers AI, `{provider}/{model}` goes through AI Gateway (`gatewayFor`: Workers AI only through a gateway when `AI_GATEWAY_ID` names one; third-party always, `default` as the fallback). Requests go out in chat-completions form; `parseCompletion` reads chat-completions, the older Workers AI shape and Anthropic blocks, since which one comes back depends on the model
- Tool parity for free: the MCP server factory moved to `mcp/server.ts`, and the runner connects an MCP `Client` to it over `InMemoryTransport` — same schemas, same scoping, minus `set_model`/`get_model` (Anthropic-catalog features). Tool results capped at 96KB before they enter the transcript
- The router drives both runtimes through a `SessionGateway` subset of the Anthropic gateway, chosen per agent (`sessionGateway`); `StoredSession.runtime` lets the pump pick without an agent row. The runner emits the event subset the pump reads (`status_running`/`idle` with stop reason/`terminated`/`error`/`agent.message`), so death notices, thinking indicators and status broadcasts are untouched. `max_model_calls` (40 per wake) is the budget stop
- Managed-only paths skip Cloudflare agents: registration/roster sync, connector resync (debt forgiven), the key-change reset. System prompt drops the Subagents section and the `set_model` sentence for the runtime
- 1050 unit tests (up from 1004): parser dialects, the step machine incl. resume and pending merge, the DO end to end against the real tools and a scripted `AI`, routes validation per runtime, router gateway selection with no Anthropic key
- Live acceptance on the dev server (agent-browser, dev login): created "EdgeBot" on the Cloudflare runtime with the default model, put it in a new channel, mentioned it — it replied in a thread ("12 times 12 is 144.") through the real `post_message` tool on Kimi K2.5 via the `AI` binding, went idle, and a follow-up in the thread was sent into the same runner session and answered ("13 times 13 is 169.") with no second session and no runaway. No Anthropic call was involved in either turn

**Lessons learned:**
- Writing back a run-meta object read *before* a step rolled back the sequence counters the step had advanced, silently overwriting the assistant message and its event with the next ones. Every meta write now merges onto current storage (`patchRun`); the integration test caught it, the unit tests could not
- `env.AI.run()` accepts third-party models (`openai/...`, `anthropic/...`) with a `gateway` option — one binding covers "hosted on CF" and "through their gateway", and the app never holds a provider key
- The response dialect is per model: the generated binding types say newer Workers AI models (kimi, glm, gpt-oss) answer in chat-completions form and older llama ones in `{response, tool_calls}`, so the parser reads both plus Anthropic blocks. Only Kimi K2.5's chat-completions shape was confirmed live (through the binding, in the app); a direct REST probe with the wrangler OAuth token got an authentication error, so the other shapes rest on the types and unit tests

**Avoid next time:**
- Don't route every Workers AI call through an auto-created gateway: that silently moves logging and billing. Only when `AI_GATEWAY_ID` is set, or when the model leaves no choice
- Don't offer a tool the runtime cannot honour (`set_model` here): filter at listing time *and* refuse the call
- `askFast` (thread addressing, Slack thinking line) now falls back to Workers AI (`@cf/meta/llama-3.1-8b-instruct-fp8`) when there is no Anthropic key, so a key-less deployment keeps both; with a key, Haiku is still preferred

---

## Cycle 15 — Surface session deaths, thread replies to mentions, $10 budget (2026-08-21)

**Goal:** Kill the silent failure mode: a Slack mention ("@BruceAgentum go to theguardian.com/au…") produced browser activity but no reply, no error, no log.

**What we did:**
- Diagnosed from production: queried remote D1 for the message/mention/activity trail, then read the Anthropic Managed Agents session transcript directly (`client.beta.sessions.events.list`) — the session died with `stop_reason: budget_reached` at 105¢ of a 100¢ cap, having carried 66¢ from an earlier task into the reused session (b0a54cf)
- Carried `stop_reason` through the gateway into `reduceEvents`; an abnormal stop now deletes the spent session and posts a death notice, as the agent, into every thread showing "Thinking…" (posted *before* `setStatus("error")`, which would retire the very placeholder the notice rewrites) — via `createMessage` + broadcast + mirror directly, not `publishMessage`, since that would RPC the router DO back into itself
- Raised `SESSION_BUDGET_CENTS` to 1000 ($10); a top-level channel mention now retires an idle session and starts fresh, so a new task gets a full budget — thread replies still reuse (the conversation continuing). Wake dispatch kind (`immediate`/`digest`) now travels to `wake()` and through the queue
- Channel mentions are instructed to reply in a thread under the mentioning message; the "Thinking…" placeholder posts straight into that thread (skipping `assistant.threads.setStatus`, invisible for a thread that does not exist yet), so the thread + activity line appear the moment work starts
- Web UI: `use-conversation` seeds agent statuses from `getAgentStatus` on mount — the socket only carries transitions, so a tab opened mid-task used to show nothing

**Lessons learned:**
- `session.status_idle` is not "finished": its `stop_reason` distinguishes `end_turn` from `budget_reached`, and dropping it turns a platform kill into indistinguishable silence
- Session budgets are per-session, so session *reuse* quietly shrinks the budget of every later task; per-task sessions are the fix, not just a bigger cap
- A Slack `assistant.threads.setStatus` on a message with no thread yet shows nobody anything — the placeholder message is what creates the thread
- Drizzle's bun-sqlite driver has no `batch()`; test harnesses that reach `createMessage` need a shim (statements are thenables, `Promise.all` suffices)

**Avoid next time:**
- Don't call `publishMessage` from inside the AgentRouter DO — `notifyRouter` would RPC the object back into itself; use `createMessage` + `broadcastChannelEvent` + `mirrorMessageToBridges` directly
- Sessions created before a budget change keep their old cap until replaced — expect one more stale-session death after deploy, now announced
- `session.status_terminated` still ends silently (delete + idle); only abnormal idle stops post the notice

## Cycle 14 — search_messages MCP tool + wiki_search LIKE fix (2026-08-21)

**Goal:** Give agents a way to find past conversations by content ("yesterday's thread") instead of paging `read_channel` backwards one channel at a time.

**What we did:**
- `search_messages` MCP tool (442eb9e): plain substring search over message bodies across every channel the agent belongs to, newest first, thread replies included. Each hit names its channel and thread so the agent lands mid-conversation and reads outwards via `read_thread`
- Scoping is two joins in one query, not a loop over channels: `channels` confines to the workspace, `channel_members` to the agent's memberships — a channel the agent was never added to is indistinguishable from one with no match, and naming one outright is refused in `read_channel`'s exact words
- Hits are budget-truncated like exec stdout (`withinOutputBudget`), with a note saying how many matches were dropped; zero hits is an answer with a nudge to try another word, not a failure. No migration, no index — `LIKE '%...%'` can't use one
- Fixed latent `wiki_search` bug found by this work (e72852f): `searchPages` backslash-escaped `%`/`_` but had no `ESCAPE` clause, so any query containing them silently matched nothing. Regression test mutation-checked (fails with the fix reverted)

**Lessons learned:**
- SQLite's bare `LIKE` has no default escape character: escaping wildcards with `\` and forgetting `ESCAPE '\'` makes the query match *nothing*, silently — worse than not escaping at all
- Drizzle's `like()` helper can't carry an ESCAPE clause; a raw `` sql`... LIKE ${p} ESCAPE '\\'` `` fragment is required
- The wiki bug sat unnoticed until parallel work hit the identical trap — the escaping looked correct in isolation

**Avoid next time:**
- Any user input flowing into LIKE needs both wildcard escaping and the `ESCAPE` clause; one without the other is broken in different ways
- When an escaping bug turns up, grep the other `like(` call sites in the same pass (done here: no third instance remains)

## Cycle 13 — Model configuration: per-agent, per-conversation, per-routine + agent-managed routines (2026-08-21)

**Goal:** Implement docs/plan-model-config.md — a model picker in agent config, per-conversation ("use opus for this thread") and per-routine model overrides working across Slack/web/routines, and agents managing their own routines via chat.

**What we did:**
- Model catalog (`AVAILABLE_MODELS`: Opus 5, Sonnet 5 default, Haiku 4.5) in anthropic/config; nullable `agents.model` and `routines.model` plus new `agent_model_overrides` table, all in one migration (0019); precedence lives in one place: `resolveModel` — thread override > channel override > agent.model > `AGENT_MODEL`
- The load-bearing application point is session creation, not registration: `createSession` always sends `agent: { id, type: "agent_with_overrides", model }` (verified in the SDK types before planning — omitted fields preserve the registration), so a model change can never be lost to the best-effort background sync. The router compares effective model against `StoredSession.model` on both the reuse and create branches; mismatch retires the session and starts fresh. Mixed digest batches fall back to `agent.model ?? default`
- Per-conversation overrides are set by the agent itself via new MCP tools `set_model`/`get_model` (self-scoped, catalog-validated, effect-from-next-wake stated in the description) — one mechanism covers Slack, web and routines because all three converge on the same mention → router → session path. `set_model` normalizes a reply id to its thread parent, since agents naturally pass the message that woke them
- Routine models materialize as a thread override at fire time: `fireRoutine` splits `publishMessage` into `createMessage` → `upsertOverride` → `fanOutMessage`, so the override is committed before the router can wake
- Agent-managed routines: MCP tools `routine_list/create/update/delete`, strictly self-scoped, sharing validation with the HTTP routes via new `routines/validate.ts` (matching the skills/validate.ts precedent) — bad schedules/timezones/models come back as tool text the agent can relay; every mutation re-arms the RoutineScheduler. System prompt gained a line advertising both capabilities
- Frontend: shared `ModelSelect` (workspace default / agent default + catalog; stale ids keep their own option so a pinned retired model isn't silently re-pointed), wired into agent dialog and routine form; model shown in routine facts only when set
- 929 unit tests (up from 853), 27/27 e2e incl. new model round-trip specs, typecheck/ultracite clean; migration applied to remote D1 and deployed to agentum.rockyshoreslabs.io. Implemented on main by forge-m1 (backend plumbing), forge-m2m3 (overrides + routine tools), forge-m4 (frontend), run sequentially

**Lessons learned:**
- `sessions.create` accepts `agent_with_overrides` with a per-session `model` — checking the installed SDK `.d.ts` before planning turned "maybe re-register per thread" into a one-parameter design
- Model on `RegisterAgentInput`/`SyncAgentInput` had to be required, not defaulted: `resyncRosters` syncs every other agent on any roster change, and an optional-with-default would silently reset re-modelled agents to Sonnet on each refresh
- SQLite UNIQUE treats NULLs as distinct — the overrides table stores `''` (not NULL) for channel-level rows so the (agent, channel, thread) unique index actually dedupes
- A model-mismatch session drop can transiently exceed MAX_ACTIVE_SESSIONS by one (the dropped session was counted as a reuse); accepted, the old session idles out

**Avoid next time:**
- Don't let an agent-facing tool key thread state on the id the agent hands it without normalizing replies to their thread parent — the router resolves by parent, and the un-normalized override would never be read
- The flat $1 session budget is now model-blind: Opus sessions do less before the ceiling — revisit budgets if Opus agents start parking mid-task

## Cycle 12 — Ask-user (2026-08-21)

**Goal:** Implement docs/plan-ask-user.md — agents can ask their humans a question (clarification or a yes/no permission gate), go idle, and be woken by the answer, on both the web and Slack surfaces.

**What we did:**
- Backend (2b5e574): `modules/questions` — a question is a message with `origin: "question"` plus an `agent_questions` row (migration 0017) carrying kind/options/status/who-answered, hung off the message view so web and Slack render one question from two renderers
- First answer wins, decided by the database: a conditional `UPDATE ... WHERE status = 'pending'` — the loser gets a 409 naming the winner and posts no reply. Answering posts `@Agent Answer: <text>` in the question's thread, riding the same mention → router → wake path routines use
- Expiry resolves lazily on any access and via the existing per-workspace `RoutineScheduler` alarm for questions nobody looks at — no new DO class; the dependency runs one way, scheduler → questions. MCP tools `ask_user`/`check_answer` are scoped to the asking agent — another agent's question id reads exactly like one that never existed
- Slack (c481ab6): question cards with real Block Kit buttons on a per-app `/interactive` endpoint, signed against that app's own secret with the same bridge-ownership filter as events; the answer runs in `waitUntil` and reports through `response_url`, since waking an agent is more than Slack's three seconds are for. Resolution flows both ways — a web answer or expiry rewrites the Slack card. Manifest gains `settings.interactivity`; existing apps must re-apply it (the wizard's done card now says so)
- Web UI (4d09eab): the question message renders as a card (buttons, or free-text input) in both the stream and thread panel; one writer for card state (`useConversation.applyQuestion`) so socket broadcasts, local answers and 409s land identically. Pending badges on the sidebar/rail/Agents section off the server's `pendingQuestions` count, deep-linking to the oldest pending question via the same `?channel=&message=` link routines use
- 791 unit tests green (up from 704); boot-probe acceptance in docs/acceptance/ask-user/ — two browser clients, questions asked through the agent's own MCP endpoint, Approve waking the agent in-thread, and the second client redrawing from the broadcast. Branch `ask-user`, not yet merged; implemented by forge-askuser-1 (backend), forge-askuser-2 (Slack), forge-askuser-3 (web UI)

**Lessons learned:**
- Slack's 3-second ack window can't contain waking an agent — the interactive handler acks immediately and does the real work in `waitUntil`, reporting back through `response_url`
- Losing the answer race is an ordinary outcome, not an exception: the 409 body carries the winner's question view, which a thrown `ApiError` would have discarded — `answerQuestion` returns a union instead
- Adding a capability to a Slack app manifest (interactivity) means every already-connected app needs the manifest re-applied — that has to be surfaced in-product, not just in docs

**Avoid next time:**
- Don't model an expected race outcome as a thrown error — the loser needs the winner's data to redraw
- When a Slack manifest gains a capability, plan the re-apply story for existing installs up front

## Cycle 11 — Routines (2026-08-21)

**Goal:** Implement docs/plan-routines.md — scheduled instructions per agent that fire as real channel messages, with a per-workspace scheduler DO and run history.

**What we did:**
- Backend (c876cca): `modules/routines` — a `Schedule` union (once/daily/weekly/interval/cron) with a pure `nextRun(schedule, timezone, after)` that resolves wall clocks through `Intl`, plus an in-repo five-field cron parser (`cron.ts`); migration 0016, DO migration tag v4, routines in workspace-delete cleanup
- `RoutineScheduler` DO, one per workspace, holds exactly one alarm — the earliest `next_run_at`; missed fires collapse to a single run rescheduled from now. A fire posts `@Agent <instructions>` into the target channel with `origin: "routine"`, riding the existing mention → router → wake path, so one run is one thread and the history is real messages
- Runs are written before the post and finalized after, so "never ran" and "ran and failed" are different rows; "Run now" reuses the same path without advancing the schedule
- UI (0ad7436): `/w/$slug/routines` shaped like skills/connectors — list, per-routine run history, and create/edit as a mode of the route (a schedule picker with live preview doesn't fit a modal); the picker parses drafts through the server's own `parseSchedule` so refusals are worded identically on both sides, and previews the next three firings via the same `nextRun` the DO uses
- Runs deep-link into the conversation they produced: the chat screen gained a `message` search param that opens the thread panel on a message fetched by id (works even if the channel hasn't paged it in), cleared when the panel closes or the channel changes; the `routine:<id>` author renders as "Routine"
- 704 unit tests green (up from 632); boot-probe acceptance in docs/acceptance/routines/ — a routine created and edited through the form, a "+2 minutes" once watched through its firing, run history, and the thread link followed. Branch `routines`, cut from main after slack-apps merged; implemented by forge-routines-1 (backend) and forge-routines-2 (UI)

**Lessons learned:**
- DST makes wall-clock schedules ambiguous: `nextRun` tries both offsets around a transition — an hour that happens twice fires on the first of them, one that never happens fires a step later
- Server-rendering the browser's timezone and clock into the picker made hydration disagree with the client — those are two things the server cannot know

**Avoid next time:**
- Don't server-render values only the browser knows (timezone, current time) — fill them in on mount
- Don't duplicate schedule validation client-side — reuse the server's own parser so a bad schedule is refused in the form, worded identically, instead of as a 400 after save

## Cycle 10 — Slack apps per agent (2026-08-21)

**Goal:** Implement docs/plan-slack-apps-per-agent.md — replace the single deployment-level Slack bot with one Slack app per agent, set up through a guided wizard in the agent's settings, so each agent is a real identity in Slack.

**What we did:**
- Backend (dee3ea5): `slack_apps` table (migration 0015), one row per agent; bot token + signing secret AES-GCM encrypted with CONNECTOR_KEY — the envelope crypto moved from modules/connectors to `src/crypto.ts` (byte-format unchanged) so both modules use it without importing each other
- Wizard API on the agent: POST creates a draft and returns the generated manifest + events URL, GET re-hands both for a re-copy, PUT verifies pasted tokens via `auth.test` (recording team/bot user, or Slack's error string), DELETE disconnects and takes the app's bridges with it; no response ever returns a token
- Inbound moved to per-app `/api/bridges/slack/:slackAppId`: a draft answers Slack's `url_verification` handshake unauthenticated and nothing else; every other event is verified against that row's own signing secret, and an event is only acted on by the app that owns the channel's bridge — two bots in one channel can't double-ingest. Outbound posts through the bridge's own app token, with no `Name:` prefix for the app's own agent
- Clean break from env credentials: `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET`, `readSlackConfig`, `slackSurfaceStatus` and the old single `/api/bridges/slack` events route are gone (leftover prod secrets to delete at deploy); channel settings now says "connect an agent first" and the bridge picker offers only agents with an active app
- Wizard UI (8cff383): a fourth agent-settings section is the whole wizard; the step is derived from the `slack_apps` row (`lib/slack-wizard.ts`, unit-tested), so closing the dialog halfway and coming back resumes — manifest copy block with the api.slack.com click-path, guided token entry with Slack's rejection ("invalid_auth", …) inline and fields kept for retry, done-step with the `/invite` line and an inline-confirmed disconnect
- Also committed plan docs for the next features (9153d0d): routines (per-workspace `RoutineScheduler` DO alarm, runs are real channel messages) and ask-user — decisions taken with the user on 2026-08-21
- 632 unit tests green; e2e spec that asserted the removed env-status copy now asserts the new empty state; browser acceptance walked the wizard end to end including a live `invalid_auth` rejection, a resumed error state, and a real connected app — 11 screenshots in docs/acceptance/slack-apps/. Live message mirroring through a per-agent app was not part of the captured run. Work sits on branch `slack-apps`, not yet merged to main; implemented by forge-slack-a (backend) and forge-slack-b (UI)

**Lessons learned:**
- The draft's events URL must answer Slack's `url_verification` handshake before any secret exists — the manifest names the URL first — so that one response is unauthenticated and everything else on a draft is refused
- Two bots in one channel is now a real topology: events must be claimed by bridge ownership, not processed by whichever app received them, or every message ingests twice
- React reports a nested `<dialog>`'s close event on the outer dialog too — the disconnect confirmation became inline because a nested dialog shut the whole settings dialog

**Avoid next time:**
- Don't return stored tokens in any wizard response — verify server-side and report only status
- Don't keep wizard progress in component state — derive the step from the persisted row so abandoning mid-flow resumes instead of restarting

## Cycle 9 — Production deploy (2026-08-20)

**Goal:** First real deployment — agentum.rockyshoreslabs.io on remote D1/R2 with a production wrangler configuration.

**What we did:**
- d943c7e: deployed with remote D1/R2; the Worker Loader's `experimental` compatibility flag is rejected in deployed Workers (error 10021), so production ships without the loader — the agent computer keeps its filesystem and exec degrades to a clear error
- c40c407: folded the separate wrangler.production.jsonc back into one wrangler.jsonc via `env.production`, which clears `worker_loaders` and the experimental flag explicitly; the vite plugin resolves the environment via `CLOUDFLARE_ENV=production` at build, and `wrangler deploy` follows the emitted `dist/server/wrangler.json` through `.wrangler/deploy/config.json`
- ddaa26d: deploy script renamed to `prod:deploy`

**Lessons learned:**
- Experimental wrangler keys inherit into an env unless explicitly overridden — the first `env.production` attempt failed because omitting `worker_loaders` wasn't enough; it had to be cleared in the env block

**Avoid next time:**
- Don't assume a wrangler env starts clean — override experimental flags and loader bindings explicitly in `env.production`

## Cycle 8 — Multi-tenancy: workspaces (2026-08-20)

**Goal:** Implement docs/plan-multi-tenancy.md — everything scoped to workspaces with member-based identity, so multiple tenants share one deployment without seeing each other.

**What we did:**
- Six phases as sequential forge agents (forge-phase1..6) plus forge-db-cleanup: schema + backfill (bf79a99), workspace API + `requireWorkspace` middleware (439bcb1), scoping every resource router/service under `/api/w/:slug` (a4e0612), member identity — no Clerk ids in any view, `resolveMemberAuthors` with "Former member" fallback (570043c), per-workspace AgentRouter DO + agent-facing identity/oracle fixes (a866657), and `/w/$workspaceSlug/` UI routing with switcher, members settings and create flow (35be38e)
- `workspace_id` on the eight root tables only; children inherit tenancy through their parent and are reached by resolving the parent within the workspace first (`getMessageInWorkspace`-style accessors), so the unsafe unscoped call is no longer expressible
- Deliberately global lookups are few and doc-commented: MCP token, OAuth `state`, Slack event dedup/bridge mapping — each resolves a tenant from a credential or row that carries it
- The AgentRouter went from one global DO to `idFromName(workspaceId)`; the old singleton retires itself, and migration 0014 resets `agents.session_id`/`status` (its state mirrored into D1) so agents don't claim "working" against dead sessions
- Frontend: `lib/api.ts` became a `createApi(slug)` factory handed down via `useApi()`; provider keyed by slug so no state (including the channel socket) survives a workspace switch; `/` is a doorway to your last/first workspace
- Rebuilt migration 0012 (ddabf6f) to drop the permanent `DEFAULT 'ws_default'` on `workspace_id`, wiping and rebuilding local `.wrangler/state` (no remote D1 exists); `scripts/rewrite-legacy-urls.ts` fixed pre-Phase-3 absolute `/api/…` URLs baked into stored markdown
- 566 unit tests green at Phase 3; browser acceptance verified two workspaces see only their own data and 15 API payloads scanned clean of `user_…` ids outside imageUrl (documented residual: Clerk-hosted avatar URLs embed the user id in their token; proxying avatars is future work); screenshots in docs/acceptance/multi-tenancy/

**Lessons learned:**
- SQLite `ADD COLUMN … NOT NULL` demands a constant default, and a default, once added, is part of the table for good — raw SQL that forgot `workspace_id` landed silently in the default workspace instead of failing; that's why 0012 was rebuilt
- `DROP TABLE` on a cascade parent performs an implicit DELETE that fires the children's `ON DELETE CASCADE`; `PRAGMA defer_foreign_keys` defers violations, not actions — copy-then-swap table rebuilds cannot survive cascade parents like `channels`/`categories`/`wiki_pages`
- Hono merges a nested router's params with its mount's — `/wiki/:slug` under `/api/w/:slug` got the workspace's slug; the IDOR test caught it, hence the `:workspaceSlug` mount param
- A Durable Object cannot read back the name it was addressed with — the workspace travels on `MessageNotification` and is persisted in DO storage from the first one
- A module-level "current workspace" would be a cross-tenant hazard in a server-rendering Worker (mutable global shared across concurrent requests) — per-slug API client factory instead
- Unscoped by-id reads are existence oracles: `read_channel`'s `beforeId` let an agent probe message ids across all tenants until it resolved through `getMessageInWorkspace`
- Two "check" items came back nothing-to-build after a live spike: Anthropic accepts duplicate agent names (no `{slug}/{name}` prefix needed), and vaults were already per-connector, finer than per-workspace

**Avoid next time:**
- Don't use a NOT NULL column default as a tenancy backfill vehicle — it outlives the migration
- Don't assume `defer_foreign_keys` protects data during table rebuilds; it doesn't stop cascade actions
- Don't keep unscoped by-id accessors around "for later" — put the workspace right after `db` in the signature so the unsafe call can't be written
- Don't drop a stateful DO topology without resetting its D1-mirrored state (the reason 0014 exists)

## Cycle 7 — Phase 5: Skills (versioned, agent-authored) (2026-08-20)

**Goal:** Implement Phase 5 of docs/plan-connectors-skills.md — workspace skills published to the Anthropic Skills API, versioned and pinnable per agent, authorable by agents themselves via MCP tools.

**What we did:**
- Ran both entry spikes green against the live API first (honoring the spike-first gate): multipart upload with the path encoded in the filename, version ids are epoch-microsecond strings, `"latest"` is stored literally so publishing a new version needs no agent resync, partial `agents.update` preserves omitted fields in both directions, and skill delete has no in-use protection — versions must be deleted before the skill
- Built modules/skills: migration 0011, skill files in R2, publish pipeline with local-first `sync_status` (R2 stays source of truth, Anthropic sync can lag or fail without losing data)
- Agent wiring: skills-gateway + `composeAgentSkills` do a skills-only partial `agents.update` with NO token rotation (asserted in tests); system prompt gained a skills section with the self-heal contract
- 4 MCP tools — `skill_list` / `skill_read` / `skill_create` / `skill_update` — with agent attribution; `skill_create` auto-assigns the new skill to the authoring agent
- UI: /skills directory + detail (rendered SKILL.md, file tree, version history, retry-sync, delete), create + new-version editors, agent-settings Skills tab with pin dropdown + 20-skill cap, rail chips on the agent profile
- 525 unit tests + 24/24 Playwright green; implemented via sequential forge agents (skills-spike, skills-backend, skills-ui) plus a Sonnet browser verifier (verify-phase5)
- Browser acceptance PASSED all 9 steps against the live Anthropic API: skill published for real → "synced", v1 immutability after publishing v2, pin/unpin, and delete cleaned up the Anthropic side
- In-session acceptance (initially deferred behind the tunnel requirement) COMPLETED in a follow-up run (verify-sessions, Sonnet agent) via the cycle-2 cloudflared quick-tunnel recipe — all five steps passed against live sessions: agent re-registered at the tunnel URL; Phase 4's connector tool used in chat (Cloudflare docs search, cited reply in-channel); assigned `pirate-summary` skill applied correctly; agent AUTHORED `word-count` via `skill_create` (auto-assigned, `agent:Analyst` as author); and the SELF-HEAL contract worked end-to-end — a deliberately broken v2 script was diagnosed in-session, fixed via `skill_update` (v3, agent-authored changelog), and the task completed. Screenshots in docs/acceptance/phase45-sessions/. Still skipped: real third-party OAuth (no credentials, unchanged)

**Lessons learned:**
- The Skills API download endpoint is unusable with workspace keys + the `skills-2025-10-02` header — R2 must stay the source of truth for skill files
- The markdown renderer turns YAML frontmatter into a setext h2, so the UI strips frontmatter before rendering SKILL.md
- `MAX_AGENT_SKILLS` had to live in a pure module (validate.ts) to stay browser-importable
- e2e stub servers run under Node (`node:http`), not Bun — same constraint as Phase 4's stub MCP servers
- The in-session acceptance run found a leftover second dev server (VS Code terminal, auto-incremented to port 3001) that would have double-processed mentions and doubled token spend — check for strays before live-session testing
- Pressing Enter in the mention autocomplete can send the message instead of confirming the mention — minor composer UX trap that cost one stray mention during acceptance

**Avoid next time:**
- Don't resync agents on new skill versions — `"latest"` is stored literally at Anthropic, so publish alone is enough
- Don't delete a skill without deleting its versions first; there is no in-use protection on the Anthropic side
- Don't fetch skill files back from the Skills API — serve them from R2

## Cycle 6 — Phase 4: Connectors — remote MCP servers with OAuth (2026-08-20)

**Goal:** Implement Phase 4 of docs/plan-connectors-skills.md — user-added remote MCP connectors with a "no preset list" OAuth ladder, credentials held in Anthropic Vaults, and per-agent connector assignment.

**What we did:**
- Renamed modules/connectors (Slack bridge) to modules/bridges (4c82bc2), freeing the name; routes moved `/api/connectors` → `/api/bridges` — the Slack Events Request URL is now `/api/bridges/slack/events` and must be updated in the Slack app config
- Ran the Phase 4 entry spike against the live API (`bun scripts/anthropic-spike.ts vaults`): vault CRUD, `static_bearer` + `mcp_oauth` (with `refresh` block) credentials, secret updates, `mcp_server_url` immutability, archive/delete — honoring Cycle 5's spike-first gate
- Built modules/connectors (4a/4b): migrations 0009/0010 (`connectors`, `connector_oauth_flows`, `agent_connectors`, `agents.connector_resync_pending_at`), OAuth ladder RFC 9728 → 8414 → 7591 → 7636 PKCE + RFC 8707 `resource`, token encryption, health checks, usability cap with dropped-connector reporting
- Agent wiring (4c): `vaults.ts` VaultGateway keeps the SDK confined to modules/anthropic (same pattern as gateway.ts); `agent-connectors.ts` composes `mcp_servers` + deduped `vault_ids`; the router settles deferred connector resyncs at the only safe moment — just before session create, when the agent provably has no session
- UI (4d): /connectors list + detail routes, setup dialog with OAuth popup, agent-settings Connectors tab with picker, connector chips on the profile, sidebar Connectors section
- e2e (4e): connectors.e2e.ts drives the acceptance script against stub MCP servers stood up in-run (open, OAuth-secured with its own tiny auth server, bearer-only); 462 unit tests + 19 Playwright tests (6 new) all green
- Browser acceptance (verify-phase4, Sonnet agent) PASSED all 8 steps against the live app + real APIs — added the public Cloudflare Docs MCP server (`https://docs.mcp.cloudflare.com/mcp`, no-auth), verified detail/tools/Test connection, tabbed agent settings with picker + cap indicator, rail chips, assign/unassign persistence, disable/enable; 14 screenshots in docs/acceptance/phase4/. Real-OAuth acceptance against a third-party server (e.g. Linear) SKIPPED — pre-authorized blocker, no third-party credentials in this environment
- Session ran four sequential forge agents (rename, vault-spike, connectors-module + connectors-ui as one resumed pair, agent-wiring) plus verify-phase4; Phase 4 lands as one commit right after this entry

**Lessons learned:**
- Credential `mcp_server_url` is immutable at Anthropic — changing a connector's URL means a new credential, not an update (proven in the vault spike)
- `mcp_oauth` credentials only auto-refresh when a `refresh` block is granted; a grant without one simply works until expiry
- A session fixes both `mcp_servers` and `vault_ids` at create — connector assignment changes can only reach an agent's NEXT session, so resync is deferred and settled in the router right before startSession
- The router's sessionId gate can lag by one alarm (a retired session is nulled when the pump reaches it), so a resync landing in that window defers again — matching what the UI promises anyway
- Playwright specs execute in Node workers, so the e2e stub MCP server had to use `node:http`, not `Bun.serve`, in this otherwise Bun-first repo
- The vaults API needs `?beta=true` on every path in addition to the `managed-agents-2026-04-01` header (SDK 0.118 `client.beta.vaults.*` handles both); vault/credential delete is real deletion (unlike agents' permanent archive), and deleting a vault with live credentials succeeds — so "Remove connector" is a single `vaults.delete`
- `mcp_server_url` is unique per vault, not per workspace — this is what makes the one-vault-per-connector topology work
- The SDK's MCP transport swallows the 401's `WWW-Authenticate` header (the OAuth ladder's trigger), so the probe is hand-rolled Streamable HTTP
- In dev without a tunnel, every connector-assignment resync fails at Anthropic ("MCP server URL host localhost resolves to loopback") — visible only as the agent-profile error banner; the Connectors picker itself shows no failure signal (UX gap worth revisiting)

**Avoid next time:**
- After deploying the bridges rename, update the Slack app's Events Request URL to `/api/bridges/slack/events` — the old path is gone
- Don't expect connector changes to affect a live session — they attach at session create only
- Don't leave drizzle.config.ts pointing at a renamed schema path — it silently emits DROPs for the moved tables on the next `db:generate` (caught before damage this cycle)

## Cycle 5 — Workspace UI polish, categories, hierarchical wiki + connectors/skills plan (2026-08-20)

**Goal:** Post-Phase-3 polish pass — sidebar/workspace UX cleanup, channel membership management, a hierarchical wiki, and a plan for the next capabilities (Connectors & Skills).

**What we did:**
- Sidebar overhaul (3760c10): collapsible sections persisted in localStorage with search auto-expand; "Direct messages" renamed to "Agents"; Wiki moved to a top-bar icon; footer shows the signed-in user's name
- New categories module (migration 0008, `/api/categories`): user-created categories that channels and agents sort into via per-row menus
- Channel settings gained a Members section — view, add agents, remove members (new member DELETE route), header count kept in sync
- Hierarchical wiki (44cd2c4): slugs may contain `/` (per-segment `slugifyPath`), collapsible folder tree, folder-index view for folders without their own document, `/wiki/$slug` converted to splat route `/wiki/$` so slashed slugs deep-link, `[[Ops/Runbooks]]` links resolve to nested pages; nested-page e2e added
- Ran four forge agents this session (forge-backend, forge-members, forge-sidebar, forge-wiki) on disjoint scopes; both commits batch-landed at the end
- Drafted docs/plan-connectors-skills.md (uncommitted): Connectors as user-added remote MCP servers with OAuth via Anthropic Vaults (`vault_ids` at session create, auto-refresh), Skills via the versioned skills API (`skills-2025-10-02` beta), phase-entry API spikes, and a pending naming decision — rename the Slack module to `modules/bridges` so `modules/connectors` can mean MCP connectors

**Lessons learned:**
- Four forge agents shared one working tree without conflict: backend first (sole owner of the shared `lib/api.ts` contract), then sidebar + members in parallel, then wiki. What made it safe: every prompt pinned the exact API contract, named the files the agent must NOT touch, and scoped formatting to touched files only (no repo-wide `ultracite fix`). This revises Cycle 2's "don't run forge agents concurrently on apps/web" — concurrent is fine with explicit disjoint file ownership
- A forge agent died at startup on a transient Anthropic API server error; a one-line "continue from the top" resume message recovered the full task with no rework
- Renaming a TanStack route file (`wiki.$slug.tsx` → `wiki.$.tsx`) leaves `routeTree.gen.ts` stale, so typecheck fails confusingly — run `bun run generate-routes` before diagnosing anything else
- `%2F`-encoded slashes round-trip through Hono `:slug` params intact (proven end-to-end over workerd), so path slugs needed no regex route params
- The e2e smoke test flaked once (new agent's sidebar button missing), order/state-dependent with the persistent local D1; it passed in isolation and in both later full runs
- Anthropic Vaults make an OAuth refresh daemon unnecessary for MCP connectors: credentials attach at session create and Anthropic refreshes `mcp_oauth` tokens itself; but `vault_ids` is session-create-only and invalid credentials surface as `session.error`, not a create failure
- The module named `connectors` (Slack bridge) is not the product feature "Connectors" — naming collision flagged in the plan before any new code

**Avoid next time:**
- Don't start Connectors/Skills implementation before the two phase-entry spikes (skill version upload shape; `agents.update` accepting `skills`) — the plan gates on them
- Don't locate wiki tree links by visible name in e2e — the local D1 persists across runs, so leaf titles collide; key assertions on `href` instead

## Cycle 4 — Phase 3: agent computer, agent browser, right-rail agent screen (2026-08-20)

**Goal:** Implement Phase 3 of docs/plan.md (final phase) — give each agent a computer and a browser, and surface both in a right-rail agent screen.

**What we did:**
- Built modules/computer wrapping `@cloudflare/computer` 0.2.1 (preview): an AgentComputer DO per agent via `withWorkspace`, WorkerShellBackend exec working locally, 5 MCP tools, path/SSRF-style validation
- Added a shared modules/activity log (D1 `agent_activity` table + API) used by both computer and browser
- Built modules/browser on the Browser Run Workers binding + `@cloudflare/playwright` — real binding verified, 5 MCP tools, screenshots to R2, SSRF guard; Chromium (not Kitesurf) with session reuse via undocumented `persistent:true`
- Built the right-rail agent screen: Screen/Files/Activity/Profile tabs, polling 4s working / 15s idle, upload into the agent computer, GrokBot-style empty states
- 266 unit tests + 12 e2e passing; Phase 3 browser acceptance passed all steps with real Anthropic + Browser Run, including an agent-to-agent delegation -> browse -> file -> wiki chain (screenshots in docs/acceptance/phase3/)

**Lessons learned:**
- WorkerShellBackend requires `WorkspaceServiceProxy` as a named export of the Worker entry module — it's looked up via `ctx.exports`, and this is undocumented
- Kitesurf through the Browser Run binding never acquires a session (`sessionId()` undefined in @cloudflare/playwright 1.3.5), so multi-call flows need Chromium; session reuse requires `persistent:true` on both launch AND connect, absent from the published types
- The browser binding in local dev needs `remote:true` + `wrangler login` + `CLOUDFLARE_ACCOUNT_ID`; miniflare's local Chrome fails to start on this box
- D1's `unixepoch()*1000` column default is whole-second precision — set `createdAt` from JS or same-run rows order randomly
- The sync-status UI only flips to "registered with Anthropic" on the next data refresh (registration is waitUntil-async) — minor UX gap, a freshly created agent gives no ready signal
- Known gaps deferred: Files-tab download link serves a JSON envelope, not raw bytes (needs a bytes route in 3a); Slack live round-trip still blocked on tokens; Worker Loader availability in the deployed CF env unverified

**Avoid next time:**
- Don't use Kitesurf through the Browser Run binding for anything needing more than one call — it's sessionless there
- Don't rely on D1 timestamp column defaults for ordering rows created in the same second
- Don't expect miniflare's local Chrome to work on this machine — go straight to `remote:true`

## Cycle 3 — Phase 2: Anthropic Managed Agents, agent router, MCP, wiki, Slack (2026-08-20)

**Goal:** Implement Phase 2 of docs/plan.md — wire real Anthropic Managed Agents into the workspace (routing, MCP tool access), plus the wiki module and Slack connector.

**What we did:**
- Built modules/anthropic as the gateway to the Managed Agents API — validated first with a live spike, then confirmed a real session round-trip through the workspace
- Added the AgentRouter Durable Object with hybrid wake: immediate on mention/DM, 5-minute digest otherwise, a 5-session concurrency queue, and loop guards against agent-to-agent ping-pong
- Exposed an MCP server at `/mcp/:agentToken` (@hono/mcp + @modelcontextprotocol/sdk) with 9 tools; agent tokens are stored hashed, with a rotate action in the UI
- Built the wiki module: pages, revisions, R2 assets, heading anchors, `[[wiki-links]]`, with full UI
- Built the Slack connector: signature verification, idempotent inbound events, mirrored outbound messages, and channel-bridging UI — live Slack round-trip SKIPPED (no workspace tokens; pre-authorized blocker)
- Fixed cite-tag stripping in the markdown renderer
- 190 unit tests + 9 e2e tests passing; browser acceptance passed all steps including observing the digest wake fire at exactly 5:00 (screenshots in docs/acceptance/phase2/)

**Lessons learned:**
- Anthropic environment names are NOT unique despite docs saying create returns 409 — the gateway must be list-first-adopt, or duplicate environments silently eat the 5-environment quota
- `mcp_toolset` defaults to `permission_policy: always_ask` — set `always_allow` explicitly or sessions park in `requires_action` and never call tools
- `events.list` has no after-id cursor, only `created_at[gte]` — cursor has to be timestamp plus client-side id slicing to avoid re-processing
- `agents.create` rejects loopback MCP URLs, so local dev needs a cloudflared quick tunnel; on this machine plain `cloudflared` picks up the resident /etc/cloudflared/config.yml (catch-all 404) — pass `--config <empty file>`; Vite 8 also blocks tunnel Host headers, fixed with `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.trycloudflare.com`
- The e2e Anthropic kill switch must go through `vite --mode e2e` — `.env.local` outranks process env, so exporting the variable is not enough
- `PUBLIC_APP_URL` in .env.local must be a public URL at agent create/edit time or registration with the Anthropic gateway fails

**Avoid next time:**
- Don't archive Anthropic agents/stores as "cleanup" — archiving is permanent
- Don't let two forge agents edit messaging/service.ts concurrently

## Cycle 2 — Plan Agentum + build Phase 1 workspace core (2026-08-20)

**Goal:** Turn the bootstrapped app into Agentum — plan the GrokBot-inspired agent workspace, then implement Phase 1 (channels, messages, agents CRUD) end to end with forge agents.

**What we did:**
- Committed the docs folder (ce3cce7) with docs/plan.md (docs/idea.md predates this session): Slack-like workspace on Claude Managed Agents + `@cloudflare/computer` + Kitesurf; confirmed decisions — hybrid agent wakeup, Cloudflare-native backend (DO/D1/R2), ephemeral sessions + memory stores, connector layer from day one (Slack in Phase 2)
- Wrote docs/design.md and ran Phase 1 as sequential forge agents: data layer -> UI -> e2e
- Data layer (uncommitted): Drizzle + D1 schema/migration (apps/web/drizzle/0000_init.sql), modules for messaging/agents/connectors with Hono routes, services, unit tests (mentions, attachment rules, errors); R2 `ATTACHMENTS` bucket + channel-room Durable Object wired in wrangler.jsonc
- UI (uncommitted): apps/web/src/components/workspace/ — sidebar, composer, message stream, thread panel, agent rail, agent/channel dialogs; new site chrome; six hand-rolled UI primitives instead of shadcn/ui
- E2E (uncommitted): Playwright suite (apps/web/e2e/) with auth.setup.ts reusing the dev-login flow to mint a storage state (.auth/user.json), plus smoke.e2e.ts covering agent -> channel -> mention+image -> thread -> live second browser -> agent rail
- Browser-driven Phase 1 acceptance completed and passed all 5 steps (agent create; channel+mention+image; thread + live second-session update; agent rail; layout vs grokbot.png), screenshots in docs/acceptance/phase1/; Phase 1 work is pending commit right after this entry

**Lessons learned:**
- Playwright auth: reusing `GET /api/dev-login` in auth.setup.ts gives a real Clerk session as storage state — no Clerk UI automation needed
- /dev-login had a real bug only visible in fresh browser profiles: clerk-js swaps `client.signIn` after `signIn.ticket()` succeeds, so the signal-based `finalize()` threw "Cannot finalize sign-in without a created session". Fixed by using the legacy ticket flow (`signIn.create({ strategy: "ticket" })` + `setActive(createdSessionId)`). The already-signed-in early-return path masked it in manual testing
- Clerk's provider remounts the React tree when the session resolves (children keyed on session id), wiping pre-resolve UI state — e2e tests must wait for a post-remount signal (we wait on `GET /api/channels`) before clicking
- shadcn/ui was skipped deliberately: its CLI rewrites styles.css tokens and would collide with the existing theme toggle; six primitives were hand-rolled instead (documented in docs/design.md)
- forge subagents' default model was unavailable (claude-opus[1m] API error) — forge tasks need an explicit model override

**Avoid next time:**
- Don't run two forge agents mutating apps/web concurrently — sequential data -> UI -> e2e worked cleanly
- Port 3000 is held by an unrelated app on this machine; pin dev/e2e servers to explicit ports with `--strictPort`

## Cycle 1 — Bootstrap app with Clerk auth + dev login (2026-08-19)

**Goal:** Bootstrap the app (Workers + Hono + TanStack Start + Clerk) through to a working custom /login page with one-click dev login.

**What we did:**
- Set up Cloudflare Workers + Hono + TanStack Start + Clerk (7ecc06f)
- Converted to Turborepo, moved the front end into apps/web (e6536d7)
- Added `GET /api/dev-login`: mints a Clerk sign-in token for a dedicated dev user and redeems it at `/dev-login` via `signIn.ticket` -> `signIn.finalize`, establishing a real session without a password touching the browser (f79532b)
- Gated dev login behind `DEV_LOGIN_EMAIL`/`DEV_LOGIN_PASSWORD` in `apps/web/.env.local`; their absence is the safety switch that keeps the route disabled in deployed environments
- Added `apps/web/scripts/create-dev-user.ts` (`bun run create-dev-user`) to create/refresh the dev Clerk user
- Moved Clerk sign-in off Clerk's hosted Account Portal onto a custom `/login` route (renamed from `/demo/clerk`), replacing the header's default `SignInButton` with a link to it, and removed the now-dangling "Demos > Clerk" nav entry (a2f0ade)
- Documented the dev login flow in AGENTS.md, CLAUDE.md, and .claude/CLAUDE.md so agents know to use it instead of Clerk's UI

**Lessons learned:**
- Clerk's default `SignInButton` redirects to the hosted Account Portal, which breaks a "single custom login page with a dev login option" UX — needed an explicit `/login` route + link instead of the default component

**Avoid next time:**
- Don't set `DEV_LOGIN_EMAIL`/`DEV_LOGIN_PASSWORD` outside `apps/web/.env.local` — their presence is what enables the dev-login route, so leaking them to a deployed environment would expose it
