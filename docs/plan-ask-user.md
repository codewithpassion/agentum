# Agentum — Ask-User Plan (agent questions & human-in-the-loop permissions)

Agents get an MCP tool to ask their humans something — a clarifying question
with optional choices, or a **permission request** ("may I delete these 14
rows?") that blocks the risky action on a human yes/no. Questions are visible
wherever the conversation lives: as an interactive card in the Agentum
channel, mirrored to Slack with real Block Kit buttons through the agent's
own Slack app, and surfaced in the UI so you can see at a glance that an
agent is waiting.

Decisions taken with the user (2026-08-21):
- **Async, not blocking.** The tool posts the question and returns
  immediately; the agent goes idle and the answer wakes it like a mention.
  No held sessions, questions can wait hours.
- **Slack answers are interactive buttons** (Block Kit + an interactivity
  endpoint on the per-agent Slack apps), not parsed text replies.
- Runs on top of the Slack-app-per-agent work (plan-slack-apps-per-agent.md).

## Decisions

1. **A question is a message.** New `agent_questions` table, but the user
   sees it as a special message card in a channel: the MCP tool posts a
   message (author = the agent, `origin: "question"`) whose body is the
   question, with the question row carrying the structure (kind, options,
   status). The card renders buttons in the web UI; the Slack mirror renders
   Block Kit buttons. One surface model, two renderers.
2. **Two kinds, one mechanism.** `kind: "question" | "permission"`.
   Permission is a question with fixed Approve/Deny options and sterner
   rendering. Enforcement is the agent's own protocol — the MCP instructions
   tell agents to ask before destructive/irreversible actions and wait for
   the answer. A hard policy engine (server-side blocking of specific tools)
   is explicitly out of scope.
3. **First answer wins.** Any workspace member (web) or any Slack user who
   can see the bridged channel may answer; the row records who
   (`answeredBy`: member id or `slack:U…`), when, and from which surface.
   Buttons disable after answering; a second click gets "already answered by
   NAME".
4. **The answer wakes the agent** through the router exactly like a mention:
   answering posts a reply message in the question's thread
   (`origin: "answer"`, body "@Agent Answer: <choice or text>") — the agent
   reads it in-thread with full context. Also: `ask_user` returns the
   question id, and a `check_answer` MCP tool lets a *running* session poll
   mid-task if it chose to keep working.
5. **Pending badge.** The agent rail shows a pending-question count per
   agent; a workspace-level indicator sums them. Poll/socket via the
   existing agent-status channel (the rail already polls status).
6. **Slack interactivity endpoint**: `/api/bridges/slack/:slackAppId/interactive`,
   signature-verified against that app's signing secret (same scheme as the
   events route; Slack signs interaction payloads identically). The manifest
   gains `interactivity.is_enabled: true` + `request_url`. Existing created
   apps need their manifest re-applied — the wizard's re-copyable manifest
   already covers that; the app view shows a hint when interactivity has
   never been seen for an app that has pending mirrored questions.
7. **Expiry**: optional `expiresAt` on ask (tool parameter, e.g. "30m");
   expired questions resolve as `expired`, buttons disable, and the agent is
   woken with the expiry so it can proceed with its default. No default
   expiry — most questions should simply wait.

## Schema

```
agent_questions                 (workspace-scoped root table)
  id            text PK
  workspaceId   text NOT NULL
  agentId       text NOT NULL
  channelId     text NOT NULL
  messageId     text NOT NULL       -- the question card message
  kind          'question' | 'permission'
  prompt        text NOT NULL
  options       text                -- JSON string[] | null (free-text answer)
  status        'pending' | 'answered' | 'expired'
  answer        text                -- chosen option or free text
  answeredBy    text                -- member id or 'slack:U…'
  answeredVia   'web' | 'slack'
  expiresAt     integer
  createdAt / answeredAt
  INDEX (workspaceId, status), INDEX (agentId, status)
```

Slack linkage reuses `external_refs` (the question message's mirrored `ts`
is already tracked there — button clicks carry the question id in the
action payload, not the ts).

## MCP tools (registered in modules/mcp/tools.ts, scoped as ever)

```
ask_user(channel, question, options?, kind = "question", expires_in?)
  -> { questionId, status: "pending" }   // returns immediately (async)
check_answer(questionId)
  -> { status, answer?, answeredBy? }
```

Tool descriptions teach the protocol: ask in the channel where the work is
happening; for permission-kind, do not perform the action until an approving
answer arrives; end the turn after asking — the answer will wake you.

## Answer flow

Web: the card's buttons (or free-text reply box when no options) call
`POST /api/w/:slug/questions/:id/answer { answer }` → row updated (409 if
already answered), answer reply posted in-thread, card re-renders answered
(socket broadcast), agent woken. Slack: button click → interactivity
endpoint → verify signature → parse `block_actions` payload (question id +
choice in `action_id`/`value`) → same answer path attributed to
`slack:U…` (display name via the existing slack_users cache) → respond with
an updated card via `response_url` (buttons replaced by "Answered by NAME").
The web card updates through the same broadcast; the mirrored Slack card of
a web answer updates via `chat.update` on the stored ts.

## API (workspace-scoped)

```
GET  /questions?status=pending      -> pending across workspace (badge/inbox)
GET  /agents/:id/questions          -> per-agent list (recent, both states)
POST /questions/:id/answer          -> { answer } ; 409 when already answered
```

## UI

- Question card in the message stream: prompt, option buttons (or text
  input), kind styling (permission = warning accent + Approve/Deny),
  answered state showing who/when/what, expired state.
- Agent rail badge with pending count; clicking focuses the oldest pending
  question's thread. Workspace header dot when any agent waits.
- No separate inbox page yet — channels are the inbox (deferred until scale
  demands it).

## Out of scope (deferred)

- Server-side permission *enforcement* (policy engine gating specific MCP
  tools) — the protocol is advisory this round.
- DM-targeted questions (asks happen in channels the agent works in).
- Multi-answer/quorum, answer editing, reminder nudges.

## Phases

**Phase Q1 — backend + MCP**: schema/migration, questions service
(ask/answer/expire, 409 race via conditional update), `ask_user` +
`check_answer` MCP tools with protocol descriptions, answer API + wake path,
expiry sweep (piggyback on the RoutineScheduler alarm if routines land
first, else a lightweight alarm in AgentRouter — decide in-phase against
what exists), badge counts on the agent status payload. Tests: race (two
answers), expiry wake, IDOR extension, serialization sweep.

**Phase Q2 — Slack buttons**: manifest interactivity block, per-app
interactive endpoint (signature, payload parse, attribution), Block Kit
rendering in the mirror for question messages, `chat.update` on resolution
both directions. Tests: signed/unsigned interaction, cross-app payload
rejection, already-answered click.

**Phase Q3 — frontend + ship**: question card component, badge, answer UX,
boot-probe acceptance (fake agent asks via MCP → card renders → answer →
agent woken), progress entry, commit, deploy.
