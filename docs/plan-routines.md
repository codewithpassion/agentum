# Agentum — Routines Plan (scheduled tasks for agents)

A **routine** is a named set of instructions for one agent plus a schedule:
"every weekday at 9:00, summarize yesterday's #ops activity". When it fires,
the instructions are posted into a channel mentioning the agent; the agent
wakes and does the work in the open. Past executions are browsable: a run
history per routine, each run linking to the real messages it produced.

Decisions taken with the user (2026-08-21):
- **Runs happen in a channel** — the firing posts into the routine's target
  channel and the agent responds in-thread. History is real, readable
  messages plus a run-log view that links to them. No hidden sessions.
- Schedule input is **friendlier than cron**: structured presets, not a cron
  string (cron remains available as an escape hatch — see Schedule shape).

## Decisions

1. **Scheduling via a per-workspace Durable Object alarm** — a new
   `RoutineScheduler` DO, `idFromName(workspaceId)`, same topology as the
   per-workspace `AgentRouter`. It keeps exactly one alarm: the earliest
   `next_run_at` across the workspace's enabled routines (re-armed on every
   routine create/update/delete/toggle and after every firing). No static
   cron triggers in wrangler (they can't be per-row), no polling.
2. **Firing = posting a message.** The scheduler posts the routine's
   instructions into the target channel as a message with
   `origin: "routine"`, body `@AgentName <instructions>` — the existing
   mention → router → wake path does the rest; nothing new on the agent side.
   The agent replies in the thread under that message, so one run = one
   thread.
3. **Schedules are stored structured, not as cron strings.** A `schedule`
   JSON column with a discriminated union; `next_run_at` is computed in code
   (pure, unit-tested) and denormalized onto the row for the DO's min-scan.
4. **Time zone per routine**, defaulted from the creating browser
   (Intl.DateTimeFormat().resolvedOptions().timeZone), stored as an IANA
   string. Cloudflare Workers support full ICU — `Intl` handles DST; no tz
   library.
5. **A run row is written at fire time**, before the post, and finalized
   after: history survives a failed post, and "it never ran" is
   distinguishable from "it ran and the agent failed".
6. **Missed fires collapse.** If the DO was down past a scheduled time (or a
   routine was disabled across it), the next alarm fires it once and
   schedules forward from *now* — no replaying a backlog.

## Schema

```
routines                       (workspace-scoped root table)
  id             text PK
  workspaceId    text NOT NULL
  agentId        text NOT NULL        -- who is mentioned
  channelId      text NOT NULL        -- where the run happens
  name           text NOT NULL
  instructions   text NOT NULL
  schedule       text NOT NULL        -- JSON, see below
  timezone       text NOT NULL        -- IANA
  enabled        integer NOT NULL default 1
  nextRunAt      integer              -- denormalized; null when disabled
  createdAt / updatedAt
  INDEX (workspaceId), INDEX (workspaceId, nextRunAt)

routine_runs
  id             text PK
  routineId      text NOT NULL REFERENCES routines ON DELETE CASCADE
  scheduledFor   integer NOT NULL     -- the slot that fired
  firedAt        integer NOT NULL
  status         'posted' | 'error'
  messageId      text                 -- the posted instruction message
  error          text                 -- when status = error
  INDEX (routineId, firedAt)
```

Children inherit tenancy through `routineId` (repo convention).

### Schedule shape

```ts
type Schedule =
  | { type: "once";    at: string }                       // ISO local datetime
  | { type: "daily";   time: "09:00"; weekdaysOnly?: boolean }
  | { type: "weekly";  day: 0-6; time: "09:00" }
  | { type: "interval"; everyMinutes: number }            // >= 15
  | { type: "cron";    expr: string }                     // escape hatch
```

`nextRun(schedule, timezone, after: Date): Date | null` is the one pure
function everything leans on ("once" in the past → null → auto-disable).
The cron variant supports the classic 5-field form; parse with a small
vetted implementation in-repo (no heavy dependency).

## Scheduler DO

`RoutineScheduler` (new DO binding + migration tag v4 in both wrangler
configs — remember `env.production` redeclares bindings). Storage: its
`workspaceId` (same init-on-first-contact pattern as AgentRouter). API:
`reschedule()` (recompute min `nextRunAt`, set/clear alarm) called by the
routines service after any mutation; `alarm()` selects due enabled routines
(`nextRunAt <= now`), for each: write the run row, post the instruction
message through the messaging module's publish path (author
`{ type: "external", id: "routine:<id>" }` — mirrors/wakes exactly like any
message; verify against `publish.ts` at build time), advance `nextRunAt`,
finalize the run row, then re-arm. Failures land in `run.error` and the
routine still advances (decision 6).

## API (workspace-scoped)

```
GET    /routines                    -> list (with nextRunAt, lastRun summary)
POST   /routines                    -> { agentId, channelId, name,
                                        instructions, schedule, timezone }
GET    /routines/:id                -> routine + recent runs
PATCH  /routines/:id                -> partial update incl. enabled toggle
DELETE /routines/:id
GET    /routines/:id/runs?before=   -> paged run history
```

Validation: agent and channel must resolve within the workspace; schedule
must produce a future `nextRun`; interval floor 15 minutes.

## UI

- **Routines screen** at `/w/$slug/routines`: list (name, agent, channel,
  human-readable schedule, next run, last run status dot), create/edit form
  — schedule picker with the preset types (Once / Daily / Weekly / Every N
  hours / Cron), time + weekday controls, timezone defaulted, live "next
  three runs" preview from `nextRun` so mistakes are visible before saving.
- **Run history**: routine detail lists runs (when, status, error if any);
  each `posted` run links to its channel message — "view thread" jumps into
  the conversation at that message (the chat screen already supports
  channel + message anchors or gains a minimal one).
- Sidebar entry alongside Skills/Connectors.

## Out of scope (deferred)

- Sub-15-minute intervals, per-run overrides, run-until dates, pausing on
  repeated failure (a `lastRun` error dot is enough at this scale).
- Retrying a failed post automatically; a "Run now" button IS in scope
  (trivial: fire path minus the schedule advance).
- Agent-authored routines via MCP (the tables/service make it easy later;
  the ask was a user-facing interface).

## Phases

**Phase R1 — backend**: schema/migration, `nextRun` pure function (heavily
unit-tested: DST boundaries, weekdays, once-in-past, cron), RoutineScheduler
DO + wrangler bindings (both envs), routines service + API + IDOR extension,
firing path with run rows, "Run now". Tests: DO alarm firing against faked
time (repo's DO test seams), fire→post→wake integration, missed-fire
collapse.

**Phase R2 — frontend**: routines screen, schedule picker with next-runs
preview, run history with thread links, sidebar entry. Boot-probe
acceptance: create a "once, +2 minutes" routine via dev login, watch it fire,
see the run row link to the thread.

*Done.* Screenshots in `docs/acceptance/routines/`, taken against a local dev
server with the dev login:

- `00-routines-empty.png` — the empty state, inviting the first routine.
- `01-new-routine-form-preview.png` — the form: agent, channel, instructions,
  the schedule picker, and the live "next 3 runs" preview.
- `02-routines-list.png` — the list: schedule, next run, last-run dot, and the
  row's pause / run now / edit / delete.
- `03-preview-refuses-cron.png`, `04-preview-no-future-run.png` — the preview
  showing the parser's own refusal instead of runs, in the API's words, so the
  400 is never reached.
- `05-run-history.png` — the "+2 minutes" routine after the scheduler DO's
  alarm fired it: one posted run, and the once auto-disabled itself.
- `06-resume-spent-once-refused.png` — re-enabling a spent once, refused
  inline with "This schedule has no future run."
- `07-run-thread-deep-link.png` — "View thread" on a run, landing in the
  channel with the thread panel open on the message that run posted.

A run's thread link is `/w/$slug?channel=…&message=…`: the chat screen gained a
`message` search param that opens the thread panel for that message (it fetches
by id, so it works for a message the channel has not paged in). Closing the
panel clears the param.

**Phase R3 — ship**: progress entry, commit, deploy (remember: new DO class
needs the migration tag in the deploy), live smoke: a once-routine on prod.
