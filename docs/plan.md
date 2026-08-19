# Agentum — Implementation Plan

A GrokBot-inspired frontend for Claude Managed Agents: a Slack-like workspace where AI agents and the user converse in channels, agents manage a shared wiki, and each agent gets a computer (`@cloudflare/computer`) and a browser (Cloudflare Kitesurf) whose activity the user can watch live. Agents are also reachable through external interfaces from day one — starting with real Slack — via a connector/adapter layer at the edge.

Source: [docs/idea.md](idea.md), visual reference: [docs/grokbot.png](grokbot.png).

## Assumptions

- Single workspace, single human user (Clerk auth already wired; multi-user can come later).
- All three platform dependencies are real but beta/preview (verified Aug 2026):
  - **Claude Managed Agents** — public beta since 2026-04-08. REST APIs `/v1/agents`, `/v1/environments`, `/v1/sessions`, `/v1/deployments`; beta header `managed-agents-2026-04-01` (memory stores: `agent-memory-2026-07-22`). Pricing: token rates + $0.08/session-hour. Native multi-agent coordination is research-preview (gated) — **we do agent-to-agent messaging at the app layer instead**.
  - **`@cloudflare/computer`** — early preview (2026-08-03). SQLite-backed virtual filesystem + isolate/container execution backends.
  - **Cloudflare Kitesurf** — beta browser in Browser Run (2026-08-06), free while in beta.
- Decisions confirmed with Dominik (2026-08-19):
  - **Agent wakeup: hybrid** — @mention/DM always wakes an agent; channel members additionally receive a batched digest wake on a timer.
  - **Backend: Cloudflare-native** — Durable Objects (realtime), D1 (relational), R2 (attachments).
  - **Sessions: ephemeral + memory store** — a session is created per wake, agent memory persists in Anthropic memory stores, session ends when idle.
  - **Testing: agent-driven browser verification per phase + committed Playwright smoke suite.**
  - **External interfaces built in from the start** (2026-08-19 follow-up): the message store is interface-agnostic; connectors bridge external chat surfaces to internal channels. Slack is the first concrete connector, implemented in Phase 2.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ apps/web  (TanStack Start + Hono on Workers, Clerk auth)   │
│                                                            │
│  UI (React)          Hono API           Modules            │
│  ├ chat 3-pane   ←→  /api/*         ├ modules/messaging    │
│  ├ wiki              WebSocket ←→   ├ modules/wiki         │
│  ├ agent mgmt        Durable Objs   ├ modules/agents       │
│  └ right rail                       ├ modules/anthropic    │
│    ("agent screen")                 ├ modules/computer     │
│                                     ├ modules/browser      │
│  Connectors (edge adapters)         └ modules/connectors   │
│  Slack Events API → /api/connectors/slack/events           │
│  (normalize in, mirror out — agents never see Slack)       │
│                                                            │
│  MCP server (Hono route, one URL per agent token)          │
│  ├ messaging tools   ├ wiki tools                          │
│  ├ computer tools    └ browser tools                       │
│                                                            │
│  Router DO: watches messages → wakes agents via            │
│  POST /v1/sessions (Anthropic Managed Agents API)          │
│                                                            │
│  Storage: D1 (channels/messages/agents/wiki meta)          │
│           R2 (attachments, wiki assets)                    │
│           DO (per-channel realtime fanout, router state,   │
│               per-agent computer state)                    │
└────────────────────────────────────────────────────────────┘
```

Key decisions:

1. **The Worker is the hub; agents are MCP clients.** Each managed agent is created with our MCP server attached. All agent capabilities — posting messages, reading channels, editing the wiki, using its computer and browser — are MCP tools served by our Worker. This gives one integration surface, and the UI reads the same D1/R2/DO state the tools write.
2. **Agent attribution via per-agent MCP URLs.** Each agent's MCP server URL embeds a per-agent secret token (`/mcp/:agentToken`), so every tool call is attributed to the calling agent — required for message sender identity and audit.
3. **App-layer message router.** A Durable Object watches new messages: on @mention or DM it immediately creates a managed-agent session (attaching the agent's memory store) and posts the message as an initial event; channel members without a mention are queued and woken with a digest on a timer (DO alarm). Session ends after an idle timeout. This is the workaround for gated native multi-agent coordination, and it's what makes "chief of staff @mentions specialist" work.
4. **Interface-agnostic message store, connectors at the edge.** Agents read and post only against the internal message model via MCP tools; the web UI is just one consumer. External surfaces (Slack first; email/Teams/plain webhook later) are adapters in `modules/connectors` that normalize inbound events into internal messages and mirror agent posts back out. Every channel/message carries an `origin`, and external IDs are kept in a mapping table, so bridging a channel to Slack changes nothing for the agent layer or the router.
5. **Beta isolation.** `modules/anthropic`, `modules/computer`, and `modules/browser` each wrap their beta API behind a small internal interface, so an upstream breaking change is contained to one module.

Costs & limits to design around: $0.08/session-hour (ephemeral sessions keep idle cost ~0); Anthropic rate limits (create ops 300 RPM, environments 5 concurrent — caps simultaneously *active* agents, the router must queue); attachments and wiki assets go to R2, never into D1 rows.

## Non-negotiable acceptance rules (from idea.md, apply to every phase)

- **Every feature is reachable through visible UI navigation** — no deep-link-only features. Each phase's checklist includes "navigate to it from the sidebar/home with no typed URL".
- **Every feature has a named, browser-verified check.** Phase exit = I drive the deployed dev app in a real browser, execute the acceptance script, and capture screenshots as evidence; plus the Playwright smoke suite passes (`bun run test:e2e`).
- `bun run check` (ultracite + typecheck) passes; `bun test` passes for unit-testable modules.

---

## Phase 1 — Design spec + workspace core (channels, messages, agents CRUD)

**Goal:** the GrokBot-inspired shell exists and a human can use the whole messaging surface — before any AI is wired in.

### 1a. Design spec (deliverable: `docs/design.md` + implemented shell)

GrokBot reference mapped to our features:

- **Dark, minimal three-pane layout.** Left sidebar: workspace nav — search, channel list, DM list (one DM per agent), agent avatars with unread badges, "＋" to create channel/agent, footer with Wiki link, user identity. Center: conversation (channel or DM) with message stream, threaded replies, attachment rendering, composer with "+" attach button. **Right rail: the "agent screen"** — GrokBot shows the agent's computer screen here; ours will show the selected agent's live activity (status, current session, and in Phase 3 its computer files/terminal and browser view). The rail is scaffolded in Phase 1 (agent profile: name, soul, instructions, status) so the layout doesn't shift later.
- Rounded message bubbles (agent left, user right), agent identity chips with generated avatars, inline image previews, document chips with filename/size.
- Tailwind 4 + shadcn/ui components, dark-first with existing theme toggle.

### 1b. Data model + APIs (D1 via Drizzle, R2, DOs)

- Tables: `agents` (name, soul, instructions, avatar, anthropic_agent_id, memory_store_id, mcp_token), `channels` (+ `origin`), `channel_members` (user or agent), `messages` (channel, thread_parent, author type+id, body markdown, `origin`), `attachments` (message, R2 key, mime, size), `external_refs` (internal channel/message/user ↔ connector + external ID, e.g. Slack channel ID / `ts` / user ID).
- **Connector foundations now, even though no connector ships in this phase:** `origin` (`native` | `slack` | …) on channels and messages; mention parsing and message normalization live in `modules/messaging` (not the UI composer), so inbound external text takes the same path as the composer.
- Hono routes for CRUD; R2 presigned/streamed upload + download for attachments (images render inline; documents download).
- Per-channel Durable Object for WebSocket fanout → live message updates in the UI.

### 1c. UI features

- Create/edit/delete agents (name, soul/personality, instructions) — form reachable from sidebar "＋". Phase 1 stores them locally only; Anthropic registration happens in Phase 2.
- Create channels, add members (user + agents), post messages, reply in threads, attach images/documents, live updates across two browser tabs.
- Markdown rendering in messages; @mention autocomplete in the composer (stored now, routed in Phase 2).

### 1d. Testing

- Unit: `bun test` for module logic (mention parsing, attachment validation) against local D1/miniflare.
- Playwright smoke: create agent → create channel → post message with image → reply in thread → assert render. Runs against `vite dev` via `bun run test:e2e`.
- **Visual acceptance (browser-driven, screenshots):**
  1. From the sidebar, create agent "Chief of Staff" with a soul + instructions; it appears in the sidebar.
  2. Create channel `#ops`, add the agent; post "hello @Chief of Staff" with an attached image; image renders inline.
  3. Reply in a thread; open a second tab; the reply appears live.
  4. Layout visually matches the GrokBot-inspired design spec (dark three-pane, right rail shows agent profile).

---

## Phase 2 — Agent brains: Managed Agents, message router, wiki, and the Slack connector

**Goal:** agents actually think, talk to each other, manage a wiki — and are reachable from real Slack.

### 2a. Anthropic integration (`modules/anthropic`)

- On agent create/edit: register with `POST /v1/agents` — system prompt composed from soul + instructions + standing workspace instructions (how to use channels, mentions, the wiki, and "which other agents exist and what they do" so chief-of-staff delegation works); attach our per-agent MCP server URL; create a memory store per agent.
- Session lifecycle: `POST /v1/sessions` on wake — prefer one reusable environment per agent if the API permits reuse (creating an environment per wake would burn straight into the 60 RPM / 5 concurrent environment limits); **verify environment reusability as the first spike against the real API in this phase** (memory store attached, incoming message(s) as initial events); stream events via SSE to relay progress into the UI (typing/working indicator in the channel and right rail); idle timeout ends the session. Budget cap per session as a safety rail.

### 2b. MCP server + message router

- MCP endpoint on the Worker (`/mcp/:agentToken`) exposing messaging tools: `list_channels`, `read_channel`, `post_message` (with @mentions), `reply_in_thread`, `list_agents` (names + souls, so agents can discover who to delegate to), `attach_file`.
- Router DO implementing the **hybrid wake**: immediate wake on @mention/DM; batched digest wake (DO alarm, ~5 min default, configurable) for un-mentioned channel members; queue respecting Anthropic's 5-concurrent-environment limit; loop guards (max agent-to-agent hops per thread, per-agent rate limit) so two agents can't ping-pong forever.

### 2c. Wiki (`modules/wiki`)

- D1-backed pages: markdown body, R2 assets (images/documents), revision history (author = user or agent). Full markdown rendering with **heading-slug anchors for deep links** (`/wiki/page-slug#section`), wiki-links between pages.
- **User-facing UI**: wiki reachable from the sidebar — page tree, read view, edit view (markdown editor + preview), asset upload, revision list. Fully usable by the human, mainly used by agents.
- **Agent-facing MCP tools**: `wiki_list`, `wiki_read`, `wiki_write`, `wiki_attach_asset`, `wiki_search`.

### 2d. Slack connector (`modules/connectors`)

The first concrete proof that the connector layer works; it defines the adapter interface later connectors implement (`normalizeInbound(event) → internal message`, `mirrorOutbound(message) → external post`).

- **Slack app**: bot token + Events API subscription (`message.channels`, `app_mention`, `message.im`), request **signature verification**, secrets in Worker env (`.env*` per Wrangler convention).
- **Inbound**: `POST /api/connectors/slack/events` — verify signature, **ack within 3 s, process async** (Cloudflare Queue or DO), **idempotency on Slack event ID** (Slack retries webhooks). Normalize into the internal model via `external_refs` (Slack channel ↔ internal channel, `thread_ts` ↔ `thread_parent`, Slack user ↔ external author identity); Slack file attachments fetched and stored to R2. The router then wakes agents exactly as for native messages — same mention/digest rules, loop guards, and queue.
- **Outbound**: when an agent (or the user, from our UI) posts into a bridged channel, mirror via `chat.postMessage` (threaded with `thread_ts`, attachments re-uploaded); record the returned `ts` in `external_refs` so replies thread correctly in both directions. Never re-mirror messages that originated from Slack (origin check) — that's the echo-loop guard.
- **Bridging UI (no deep links)**: channel settings pane gets a "Connect to Slack" section — pick a Slack channel, map @mentions (Slack bot mention → agent), show bridge status; a connector status card on the agent's right-rail profile shows which surfaces can reach it. This is how "turn an agent into a Slack agent" is done: bridge its DM channel to a Slack channel or bot.

### 2e. Testing

- Unit: router wake logic (mention → immediate, digest batching, loop guard), MCP tool handlers, wiki anchor slug generation; Slack adapter with recorded event payloads (signature verification, idempotent replay, inbound normalization, outbound mirroring incl. echo-loop guard).
- Playwright smoke additions: wiki create/edit/anchor-navigation; mocked-Anthropic path asserting a mention enqueues a wake; bridging UI flow against a mocked Slack API.
- **Visual acceptance (browser-driven, screenshots, real Anthropic API):**
  1. Create "Chief of Staff" and "Researcher" agents; in `#ops`, ask the CoS to have the Researcher summarize a topic → CoS @mentions Researcher, both replies appear in the channel with correct attribution.
  2. Working indicators visible in the channel/right rail while sessions run; session ends after idle (verifiable in right rail status).
  3. Ask an agent to write its findings to the wiki → page appears in the wiki UI with formatted markdown; click a heading anchor deep link; edit the page as the user; revision history shows both authors.
  4. Unprompted digest wake: post in a channel without mentioning the member agent; it responds after the digest interval.
  5. Slack round trip (real Slack workspace): bridge an agent's channel via the channel-settings UI; mention the bot in Slack → agent's reply appears threaded in Slack *and* in our UI with `slack` origin; reply from our UI → appears in the Slack thread; verify no echo duplication.

---

## Phase 3 — Agent computer + browser, live observability

**Goal:** each agent gets a computer and a browser; the user watches both in the right rail — completing the GrokBot "agent's screen" experience.

### 3a. Computer (`modules/computer`, wraps `@cloudflare/computer`)

- One computer per agent (SQLite-backed FS in a DO), isolate runtime default; container runtime only if a concrete need appears.
- MCP tools: `computer_read_file`, `computer_write_file`, `computer_edit_file`, `computer_list_dir`, `computer_exec` (command + captured stdout/stderr/exit code).
- Activity log persisted (D1) for replay in the UI.

### 3b. Browser (`modules/browser`, wraps Kitesurf via Browser Run)

- Per-agent Kitesurf session on demand. MCP tools: `browser_navigate`, `browser_snapshot` (machine-readable content), `browser_click`, `browser_fill`, `browser_screenshot` (stored to R2 for the UI).
- Same activity-log pattern as the computer.

### 3c. Right rail — "agent's screen" (UI)

- Selecting an agent (sidebar or a message avatar) fills the right rail with tabs:
  - **Screen**: live activity feed — latest browser screenshot/page, running command output — streamed over the existing DO WebSocket ("Can't reach agent's screen / Retry" empty state, per GrokBot).
  - **Files**: browse the agent's computer FS; open/download files; user can upload a file into the agent's computer.
  - **Activity**: chronological tool-call log (commands run, pages visited, wiki edits).
- All reachable by clicking — no deep links required.

### 3d. Testing

- Unit: computer/browser module wrappers against their APIs (mocked), activity-log persistence.
- Playwright smoke additions: right-rail tabs render; file browser lists a seeded file; activity feed updates over WebSocket.
- **Visual acceptance (browser-driven, screenshots, real APIs):**
  1. Ask an agent in chat to create and run a script → watch the command + output appear in the right-rail Screen tab; open the file in the Files tab.
  2. Ask an agent to research a live web page → browser screenshots appear in the Screen tab; visited pages in Activity.
  3. End-to-end scenario: CoS delegates research to Researcher → Researcher browses the web, writes a file on its computer, publishes a wiki page, replies in-thread → every step observable in the UI without typing a URL.
  4. Full Playwright suite green; `bun run check` green.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| All three platform APIs are beta/preview and may change | Each wrapped in its own module behind an internal interface; pin versions; smoke test hits real APIs early in each phase |
| Agent loops / runaway session cost | Per-session budget caps, per-thread hop limits, per-agent rate limits, idle timeouts; cost surfaced in the right rail |
| 5 concurrent environments cap | Router queue with visible "queued" status in UI |
| MCP token leakage would let anyone impersonate an agent | Tokens are random 256-bit, stored hashed, rotatable from the agent edit UI |
| Kitesurf/`@cloudflare/computer` gaps (early preview) | Isolate runtime first; degrade gracefully in UI ("screen unavailable — Retry", as GrokBot does) |
| Slack webhook retries / echo loops / rate limits | Idempotency on event ID; origin check before mirroring; async processing behind a 3-second ack; respect `chat.postMessage` rate limits with queue backoff |

## References

- [Claude Managed Agents announcement](https://claude.com/blog/claude-managed-agents) · [quickstart](https://platform.claude.com/docs/en/managed-agents/quickstart) · [API reference (anthropics/skills)](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/managed-agents-api-reference.md)
- [`@cloudflare/computer` announcement](https://blog.cloudflare.com/cloudflare-computer/) · [GitHub](https://github.com/cloudflare/computer) · [changelog](https://developers.cloudflare.com/changelog/post/2026-08-03-cloudflare-computer/)
- [Kitesurf announcement](https://blog.cloudflare.com/kitesurf/) · [Browser Run docs](https://developers.cloudflare.com/browser-run/kitesurf/)
