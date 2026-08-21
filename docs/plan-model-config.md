# Agentum — Model configuration plan

Three asks (2026-08-21):

- **A. Per-agent model** — the agent config dialog gets a model picker from a
  fixed list; today `AGENT_MODEL = "claude-sonnet-5"` is pinned for everyone
  (`modules/anthropic/config.ts:8`).
- **B. Per-conversation override** — "use opus for this thread": a bot can run
  a different model for one channel or thread, working identically across
  Slack, the web frontend, and routines.
- **C. Agents manage their own routines** — "@agent create a routine that runs
  weekdays at 5am, using sonnet, checking my email", "@agent what routines are
  set up", "@agent change the 5am check to 6am" — via chat on any surface,
  including a per-routine model.

## Load-bearing facts (verified in code)

1. The Managed Agents sessions API accepts a per-session model override:
   `SessionCreateParams.agent` takes
   `{ id, type: "agent_with_overrides", model }` — "Omit to use the agent's
   model" (SDK `beta/sessions/sessions.d.ts:142-157`). No re-registration
   needed to change model per session.
2. Registration sync is best-effort (`waitUntil`), so nothing may *depend* on
   the registered model being current. The session-create override is the
   load-bearing application point; `syncAgent` re-sending `model` on every
   edit (`gateway.ts:407`) is kept but is belt-and-braces only.
3. Every surface converges on one path: message → `publishMessage`
   (`messaging/publish.ts:73`) → `AgentRouter.wake` → session. Slack threads
   map to internal `threadParentId` via `external_refs`, and routines fire by
   posting an `@agent` message. So one override mechanism covers all three
   surfaces for free.
4. `publishMessage = createMessage + fanOutMessage`, both exported — a routine
   can insert its override row *between* persist and fan-out, so the router
   can never wake before the override exists.
5. Agent self-service via MCP is an established pattern (`mcp/tools.ts`
   calls the same module services as the web API; `ask_user` already re-arms
   the `RoutineScheduler` DO from inside a tool call).

## Decisions

1. **Model catalog** — `AVAILABLE_MODELS` in `modules/anthropic/config.ts`:
   `{ id, label }[]` = Opus 5 (`claude-opus-5`), Sonnet 5 (`claude-sonnet-5`,
   default), Haiku 4.5 (`claude-haiku-4-5-20251001`). Plain model strings
   only; `model_config` extras (effort, inference geo, fast premium) are out
   of scope. Every place a model enters (HTTP API, MCP tools) validates
   against the catalog server-side.
2. **Resolution order**: thread override → channel override →
   `agents.model` → `AGENT_MODEL`. One pure-ish helper
   `resolveModel(db, { agentId, channelId, threadParentId? })` owns it.
3. **The chat tool is the per-conversation interface.** A new MCP tool
   `set_model` lets the agent act on "use opus for this thread" from any
   surface. No web UI for setting overrides (a badge showing an active
   override is a later nicety); the agent dialog and routine form are the
   only new UI.
4. **Effect-on-next-wake semantics.** The turn in which the user asks for the
   switch finishes on the old model; the override applies from the next wake.
   Expected behavior, stated in the tool description so the agent says so.
5. **Session churn on model change** — the router's wake path compares the
   effective model against `StoredSession.model` (new field): mismatch →
   drop the stored session, `createSession` with `agent_with_overrides`. The
   comparison guards **both** branches: session reuse via `sendMessage`
   (`agent-router.ts:306`) and creation. A session stored before this feature
   (no `model`) counts as the old default. This one check covers UI-changed
   agent models, tool-set overrides, and routine models — no extra
   "retire session" plumbing.
6. **Wake batches spanning conversations**: if all wake entries resolve to
   the same effective model, use it; otherwise fall back to
   `agents.model ?? AGENT_MODEL`. Digest wakes span channels by design and
   will usually hit the fallback — predictable, documented.
7. **Routine model rides the same override mechanism.** `routines.model`
   (nullable = agent default). At fire time, when set, `fireRoutine` inserts
   a *thread* override for the instruction message (persist → insert override
   → fan out, per fact 4). One run = one thread, so the whole run inherits it,
   and replies in that thread keep using it.
8. **Routine self-management tools are self-scoped**: an agent lists/creates/
   edits/deletes only routines where `agentId = ctx.agent.id`, and only in
   channels of its own workspace. They reuse the HTTP routes' validation
   (`parseSchedule`, `isValidTimeZone`, `NO_FUTURE_RUN`, channel-in-workspace)
   — extracted into the routines service where not already there, never
   re-derived in `mcp/tools.ts`. Every mutation calls
   `rescheduleRoutines(env, workspaceId)`.
9. **Timezone for agent-created routines is a required tool param.** The tool
   description instructs: use the user's timezone if known from context,
   otherwise ask (the `ask_user` tool exists). No workspace-default-timezone
   feature.

## Schema (one migration)

```
agents      + model  text          -- null = workspace default (AGENT_MODEL)
routines    + model  text          -- null = agent's model

agent_model_overrides              (new)
  id             text PK
  workspaceId    text NOT NULL
  agentId        text NOT NULL
  channelId      text NOT NULL
  threadParentId text NOT NULL default ''   -- '' = channel-level override
  model          text NOT NULL              -- catalog id
  createdBy      text NOT NULL              -- "agent:<id>" | "routine:<id>"
  createdAt / updatedAt
  UNIQUE (agentId, channelId, threadParentId)
  INDEX (workspaceId)
```

`threadParentId` uses `''` (not NULL) for channel-level rows so the UNIQUE
index actually dedupes (SQLite treats NULLs as distinct). Setting a model
upserts; clearing deletes the row. No GC/housekeeping in scope.

## Plumbing

- **Gateway** (`modules/anthropic/gateway.ts`): `RegisterAgentInput` /
  `SyncAgentInput` gain `model`; `agents.create`/`update` send
  `agent.model ?? AGENT_MODEL` instead of the constant.
  `CreateSessionInput` gains `model`; `createSession` sends
  `agent: { id, type: "agent_with_overrides", model }` when it differs from
  the registered default (always sending it is also fine — omitted fields are
  preserved).
- **Router** (`modules/router/`): `StoredSession` gains `model`; `wake()`
  resolves the effective model (decisions 5–6) before reuse/create.
- **Agents module**: `CreateAgentInput`/`UpdateAgentInput` + routes accept
  `model` (validated); overrides service (get/upsert/clear + `resolveModel`)
  lives here too.
- **Routines module**: `model` through create/update service + routes;
  `fireRoutine` switches from `publishMessage` to
  `createMessage` → insert override (when `routine.model`) → `fanOutMessage`.

## MCP tools (all self-scoped, catalog-validated)

```
set_model      { channelId, threadParentId?, model }   -- "default" clears
get_model      { channelId, threadParentId? }          -- effective model + source
routine_list   {}                                      -- own routines, human schedule, next run
routine_create { name, instructions, channelId, schedule, timezone, model? }
routine_update { routineId, ...partial, enabled? }     -- incl. schedule/model/channel
routine_delete { routineId }
```

`schedule` is the existing discriminated union (`once`/`daily`/`weekly`/
`interval`/`cron`) expressed as a zod schema; validation errors
(`NO_FUTURE_RUN`, bad timezone, bad cron) return as tool-result text so the
agent can self-correct or relay them. `composeSystemPrompt` gains a line
telling agents they can manage their own routines and per-conversation model
when asked.

## UI (apps/web)

- **Agent dialog** (`agent-dialog.tsx`): "Model" select — "Workspace default
  (Sonnet 5)" + catalog labels. Through `AgentInput` (`lib/api.ts:189`) and
  POST/PATCH `/agents`.
- **Routine form** (`routine-form.tsx`): "Model" select — "Agent default" +
  catalog. Shown in routine list/detail facts.
- No thread-override UI (decision 3).

## Acceptance scenarios (each traces to a mechanism)

1. Set an agent to Opus 5 in the dialog → its next wake creates a session
   whose model is `claude-opus-5` (override param at create, regardless of
   sync status).
2. In a web thread and in a Slack thread: "use opus for this thread" → agent
   calls `set_model` with that thread's ids → next reply in the thread runs
   on Opus; other conversations unaffected.
3. "@agent create a routine that runs every day on weekdays at 5am, using
   sonnet, checking my email and giving me a rundown" → `routine_create` with
   `{ type: "daily", time: "05:00", weekdaysOnly: true }`, `model:
   "claude-sonnet-5"`, timezone from context or asked.
4. "@agent what routines are currently setup" → `routine_list`.
5. "@agent change the 5am main check routine to 6am" → `routine_update` on
   the matching routine with `time: "06:00"`.

## Tests

- `resolveModel`: full precedence, `''` sentinel, unknown-model rejection.
- Router wake: model mismatch retires + recreates (existing DO test seams);
  pre-feature stored session treated as default; mixed-batch fallback rule.
- `fireRoutine`: override row exists before fan-out (ordering assertion);
  no row when `routine.model` is null.
- MCP tools: self-scoping (cannot touch another agent's routines/overrides),
  schedule/timezone validation parity with the HTTP routes, `NO_FUTURE_RUN`
  surfaced as tool text.
- Routes: unknown model → 400 on agents and routines endpoints.
- e2e: agent dialog round-trips the model field; routine form shows model.

## Out of scope (deferred)

- Per-model session budgets — the flat $1 ceiling (`SESSION_BUDGET_CENTS`)
  means Opus sessions do less before stopping; a budget-per-model map is a
  future knob.
- `model_config` extras: effort, inference geo, fast premium.
- Web UI for setting/clearing conversation overrides; an "override active"
  badge in the thread panel.
- Override housekeeping (rows for deleted threads/channels are inert).
- Agents changing *other* agents' models or routines; workspace default
  timezone.

## Phases

**Phase M1 — model plumbing (backend):** catalog, migration (all three schema
changes), `agents.model` through service/routes/gateway sync, `resolveModel`
+ overrides service, router wake changes + `agent_with_overrides` session
create, unit tests.

**Phase M2 — conversation + routine overrides:** `set_model`/`get_model` MCP
tools, `routines.model` through service/routes, `fireRoutine` override
insertion, tests.

**Phase M3 — routine self-management:** `routine_list/create/update/delete`
MCP tools reusing service validation, system-prompt line, tests.

**Phase M4 — frontend + ship:** agent-dialog and routine-form model selects,
routine facts display, typecheck + unit + e2e green, browser acceptance of
the five scenarios via dev login, progress entry, commit, deploy.

M2 and M3 are independent after M1.
