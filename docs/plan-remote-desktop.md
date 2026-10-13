# Remote desktop: porting the TrueForge computer stack, implementation plan

Source: the `trueforge` fork, branch `dom/main` at `b3aded57` (2026-09-26),
phases 8a to 9c. That work is ours and unpublished, so there is no upstream to
track for these parts and no licence question. This document is a port plan,
not a design from scratch. Where TrueForge already made and tested a decision,
we take it. We deviate only where Agentum's shape makes something simpler.

Reference docs in the fork: `docs/remote-computers-plan.md`,
`docs/remote-computers-protocol.md` (the frozen v1 wire contract, §7 is the
desktop extension), `docs/remote-desktop-plan.md` (§4.4 lease matrix, §11 owner
decisions), and `PROGRESS.md` cycles 25 to 41.

## Goal

A self-hosted agent computer can run a real desktop. The agent sees it through
screenshots and drives it with mouse, keyboard and clipboard tools. A person
can watch the same screen from the agent rail, take control, and hand it back.
The agent can also ask for help with a `request_human_takeover` tool, for
example to get past a login or a CAPTCHA.

On the way, the self-hosted daemon gets the more mature TrueForge client:
concurrent `exec` with cancel, chunked file transfer, a versioned protocol with
golden fixtures, and a relay that survives hibernation and deploys.

Out of scope, written down so nobody builds it by accident:

- VNC or WebRTC streaming (TrueForge 9d). Polled JPEG frames gave about 0.5 s
  keystroke echo, which was good enough.
- A hosted desktop on Cloudflare (TrueForge 9e). The `AgentComputer` DO stays
  desktop-less.
- An approval gate for `exec` (TrueForge 8d), `install-service`, and signed
  releases.
- The Code Mode reverse channel (TrueForge 8e).
- The Go client's `--allow`, `--deny` and `--allow-env` policy flags. We keep
  `--read-only` and `--workdir-only`.

## Prerequisites

1. Push `dom/main` to the `cwp` remote. Today the source branch exists on one
   disk only.
2. Phase 0 spikes pass (see below). The image spike decides whether the managed
   runtime gets the feature at all.

## The shape in one paragraph

The Go program `trueforge-computer` moves into this repo as `apps/computer`
and replaces `computerd`. It dials out to `/api/computer-hosts/connect` as
`computerd` does now. With `--desktop` it supervises Xvfb and openbox, captures
the screen in pure Go, and drives input through xdotool and xclip. The
`ComputerRelay` Durable Object is rewritten from TrueForge's
`RemoteComputerDO`: generation-stamped sockets, random request ids, state in
storage, and a desktop lease that decides whether the agent or a person may
touch the screen. Tool results learn to carry images on both runtimes, stored
in R2. The rail's Screen tab shows the live desktop, and takeover reuses the
`ask_user` pattern. The agent posts a card and ends its turn, and the
hand-back reply wakes it.

## Locked design decisions

### 1. The daemon is the Go client, ported, not rewritten

`packages/trueforge-computer` moves to `apps/computer` with its history of
fixes intact. Everything desktop-shaped is already Go and tested, including xgb capture, the
xdotool and xclip wrappers, Xvfb supervision with an auth cookie and no
listeners, `Dockerfile.desktop`, `seccomp.json`, the chromium wrapper, and
the xterm resources. Our stack default for new work is Bun, but this is a
port of working code, not new work. A Bun rewrite is not an option.

Alternative: add a desktop to `computerd`. Rejected because it would redo
tested work in a runtime with no pure X11 client.

Fallout to handle in P1:

- Env vars become `AGENTUM_URL` and `AGENTUM_COMPUTER_TOKEN` (or flags), with
  the TrueForge names removed.
- Images: `ghcr.io/codewithpassion/agentum-computer` and
  `agentum-computer-desktop`, built by a replacement for
  `.github/workflows/computerd.yml`.
- `computer-token-panel.tsx` shows the new `docker run` command, including
  `--security-opt seccomp=...` for the desktop image.
- `apps/computerd` is deleted once nothing uses it.
- The Go module path, binary name and user-visible strings are renamed from
  `trueforge` to `agentum`.

### 2. One transport: the daemon always dials out (Fly included)

The Go client only connects out. `fly-transport.ts` and `computerd` listen
mode exist only for Fly, and Fly has never run against a real account. Fly
machines run the Go client in connect mode with a per-machine token, and reach
the same relay. `fly-transport.ts` and listen mode are deleted. The Fly gateway
(Machines API create, start, stop and delete) stays.

Alternative: keep `computerd` for Fly only. Rejected because it keeps two
daemons and two protocols alive for a backend nobody has used.

### 3. The protocol is TrueForge's v1, taken wholesale

`protocol.ts` (Zod) moves to `modules/computer/protocol.ts`. The golden
fixtures in `testdata/protocol/*.json` are shared by the Go tests and a new
Agentum test, so both sides check the same frames. `PROTOCOL_VERSION = 1`
stays, and so does the additive rule. A new op joins v1 only behind a
`hello.capabilities` field that defaults to false.

When the relay and the client disagree, the relay changes. The client is
tested on real machines; the relay is the part being ported.

The hand-written types in `remote-client.ts` and `apps/computerd/src/protocol.ts`
go away. `ComputerBackend` keeps its shape, so the tools, the Files tab and the
activity feed do not change.

### 4. `ComputerRelay` is rewritten in place

Keep the class name and binding, so wrangler needs no `renamed_classes`
migration. Current storage holds only `hostId` and `daemon`, so nothing is lost.

From `RemoteComputerDO` we keep:

- the generation stamped into the socket attachment, and selecting the current
  socket by generation;
- random request ids (`crypto.randomUUID()`), with the pending entry
  registered before the frame is written;
- the staleness poll inside the waiting request, with no liveness alarm;
- auto-response ping and pong, and liveness read from
  `getWebSocketAutoResponseTimestamp` after hibernation;
- `orphaned_request_ids`, cancelled on the next connect;
- the 60 s alarm writing last-seen, expiring leases and retrying clipboard
  clears;
- close codes 4400, 4401, 4408 and 4409.

TrueForge's D1 presence writes map to `touchHostSeen` and `setHostStatus`.
`hello` is stored and re-parsed with `safeParse` on wake.

We fix one thing at the port. The DO folds every client error into `bad_request` with
the code in the message, and the HTTP layer sniffs the prefix. Here the relay
returns `{ reason, code, message }`, and callers switch on `code`.

### 5. Enrollment: the one-time token is the machine credential

Superseded on 2026-10-13: hosts use TrueForge's enrollment codes. See
[tasks-remote-desktop.md](tasks-remote-desktop.md), group E.

Agentum already mints a token per host, shows it once and stores its hash. The
daemon takes that token as its credential and presents it as a Bearer header on
the upgrade, as `computerd` does. The Go `enroll` command and the
`computer_enrollment` table are not ported. Rotation stays as it is today. The
owner mints a new token and the relay closes the old socket with 4401.

Alternative: TrueForge's enrollment code, redeemed once for a machine
credential. It is safer if the `docker run` line leaks, but costs a table, a
redeem race and a second flow. We can add it later without a protocol change.

### 6. The lease is keyed by agent, not by turn

One host serves one agent and is fixed at creation, so the agent lease holder
is `agent{agent_id}`, not `{session_id, turn_id}`. The human holder is
`human{user_id}`. These rules stay as they are in TrueForge:

- The lease is decided synchronously, before the first `await` in `request()`.
- While a person holds control, every agent op except `cancel` is refused with
  `human_in_control`. That includes `exec` and file ops, because `DISPLAY` is
  set in the exec environment.
- A person may take a screenshot without the lease. Input and clipboard need
  it.
- Idle expiry is 10 minutes for the agent and 5 for a person. Renewals are
  persisted at most every 30 s.
- When a person's control ends, both clipboard selections are cleared. After
  3 failed clears, exec and file ops resume and desktop ops stay refused.

Release at turn end:

- Cloudflare runtime: at the end of the `runner/step.ts` loop.
- Managed Agents: on `session.status_idle` in the event loop that already
  watches each session.
- Backstop on both: the 10-minute idle expiry.

### 7. Takeover reuses `ask_user`

We do not port `ClientSideTool`, `required_actions`, the turn executor resume,
or the `require_tip` compare-and-set across every store.
`request_human_takeover{reason}` behaves like `ask_user`:

1. It posts a takeover message (`origin: "takeover"`) plus a row in
   `agent_questions` (or a sibling `kind` column), and tells the agent to end
   its turn.
2. The person opens the Screen tab, takes control, works, and hands back with
   an optional note.
3. Hand-back settles the row with `UPDATE ... WHERE status = 'pending'` and
   posts the note as a thread reply. That reply wakes the agent through the
   router like any mention.

This is safe without a compare-and-set on the turn because the agent's turn
has already ended. Two people answering at once race on the row, and the
loser gets "already handed back". Cancelling the request settles the row the
same way. Expiry uses `sweepExpiredQuestions`.

### 8. Images in tool results, on both runtimes

Today neither runtime carries images. `modules/mcp/format.ts` returns text
only, `runner/tools.ts` `textOf()` drops non-text blocks, and
`ChatMessage.content` is a string. Even `browser_screenshot` returns a URL the
model cannot see.

The port:

- **Storage.** Bytes go to R2 `ATTACHMENTS`. Generalise the
  `browser_screenshots` table and its Clerk-authenticated route into one
  `agent_images` index (source `browser` or `desktop`), rather than adding a
  second store.
- **Limits at write time.** 3.75 MiB per image, 8000 px per side, 20 MiB of
  base64 per model request. Keep the newest 5 images and stub the oldest once
  more than 10 are live, in one batch, so the Anthropic cache prefix stays
  stable. An image that fails a check or cannot be loaded becomes a text stub
  and never fails the turn.
- **MCP.** Tools return an MCP `image` content block plus a short text part.
  The managed runtime gets whatever P0 proves reaches the model.
- **Cloudflare runtime.** `ChatMessage` content becomes text or a list of
  parts, sent as OpenAI `image_url` data URLs through AI Gateway. Models that
  P0 shows cannot take images get the text stub, and the desktop tools tell
  the agent so.
- `browser_screenshot` moves onto the same path in the same phase.

### 9. Access is the agent's host, nothing else

`computer_agent_access` is not ported. An agent may use the host in
`agents.computer_host_id`. A person may watch and take control if they are a
member of the agent's workspace. Owner-only rules for hosts stay as they are.
Cookie-authenticated writes on the desktop routes port `isForeignOriginWrite`:
the Origin must match the request's own origin or `PUBLIC_APP_URL`. This check
is tested through `wrangler dev`, not with injected deps (TrueForge cycle 40).

### 10. Schema: one migration

`0024_remote_desktop.sql`:

- `computer_hosts.capabilities` (JSON from `hello`: `desktop`,
  `desktop_unavailable_reason`, `python3`, `git`), plus `protocol_version` and
  `os`/`arch` for the host detail page.
- `agents.computer_desktop` (boolean, default false). The desktop tools are
  offered only when this is on and the host reports `capabilities.desktop`.
- `agent_images` (generalised from `browser_screenshots`, with a data copy).
- `agent_questions.kind` (`question` or `takeover`), if the takeover shares
  that table.

The lease and any takeover state the relay needs stay in DO storage. The
activity kind `computer.desktop` needs no migration.

### 11. Agent tools

Ported from `desktopTools.ts` onto our MCP server (`modules/mcp/tools.ts`):

| Tool | Params | Returns |
| --- | --- | --- |
| `computer_screenshot` | none | image |
| `computer_click` | `x, y, button=left, count=1` | image after 500 ms |
| `computer_type` | `text` (≤ 512) | image after 500 ms |
| `computer_key` | `keys` (`ctrl+l`) | image after 500 ms |
| `computer_scroll` | `x, y, dx, dy` | image after 500 ms |
| `computer_drag` | `from, to` | image after 500 ms |
| `computer_clipboard_read` | none | text |
| `computer_clipboard_write` | `text` (≤ 64 KiB) | text |

A serial queue per agent stops parallel calls from interleaving.
`desktopFailureText` turns each failure code into an instruction for the model,
for example "a person is using the desktop, end your turn and wait".
`request_human_takeover` is added alongside. Activity rows of kind
`computer.desktop` record action types and counts, never typed text.

## API contract (under `workspaceScopedRoutes`)

All take the agent id, because access follows the agent (decision 9).

| Route | Purpose |
| --- | --- |
| `GET /agents/:id/desktop` | status: connected, desktop capability, who holds control, lease time left, pending takeover |
| `GET /agents/:id/desktop/screenshot` | JPEG, `Cache-Control: no-store` |
| `POST /agents/:id/desktop/input` | `{ actions[] }`, answers with a fresh JPEG |
| `GET` / `PUT /agents/:id/desktop/clipboard` | read or set text |
| `POST /agents/:id/desktop/take-control` | take the human lease |
| `POST /agents/:id/desktop/hand-back` | `{ note? }`, releases and settles a pending takeover |
| `POST /agents/:id/desktop/cancel-takeover` | settles a pending takeover without control |

Status codes, from `relayFailure`: 423 `human_in_control` and 423
`lease_required`, 409 `clearing`, 503 `desktop_unavailable`, 502
`desktop_failed`, 503 `offline`, 403 for a foreign Origin.

## UI

- `useDesktopScreen.ts` and `desktopInput.ts` are copied unchanged. They depend
  only on a small server interface, which we implement against the routes
  above.
- `DesktopScreen.tsx` is reskinned onto our hand-rolled primitives.
- The rail's Screen tab shows the live desktop when the agent has one and
  falls back to today's browser and exec view when it does not.
- `computer-host-detail.tsx` gets a Desktop section showing the capability,
  the unavailable reason, and the desktop `docker run` command.
- The agent dialog gets a "Desktop" switch under `ComputerFields`, enabled only
  for self-hosted and Fly hosts.
- The takeover card is a `question-card.tsx` variant with "Open screen",
  "Hand back" and "Cancel".
- Desktop tool calls appear in the activity feed with a thumbnail.

Behaviour to keep from TrueForge:

- one frame request and one input request in flight;
- slower polling when the tab is hidden or someone else has control;
- the Ctrl+Alt+Shift release chord, with the keyboard sink at `tabIndex -1`;
- hand back on unmount, and pause rather than unmount below `md`.

## Phase-entry spikes (P0, in `scripts/`)

1. **Managed Agents image spike.** An MCP tool on `/mcp/:agentToken` returns an
   MCP `image` block of a known picture. Ask the agent what it sees. If
   nothing reaches the model, the managed runtime gets the text stub, and the
   desktop ships Cloudflare-runtime-first.
2. **Cloudflare runtime image spike.** Send an OpenAI-format `image_url` data
   URL through AI Gateway to one Anthropic model and one Workers AI vision
   model. Record which accept it and how they fail.
3. **Relay spike.** On a branch where only the connect route changes, the Go
   client dials the current relay, sends `hello`, and runs `exec`. This proves
   the auth path and finds wire gaps before the rewrite.

## Phases

Each phase ends with a live check, as cycles 17 and 18 did.

- **P0, spikes.** The three above. Go or no-go recorded in this file.
- **P1, daemon and relay.** Move the Go client into `apps/computer` and rename
  it. Port `protocol.ts` and the fixtures. Rewrite `ComputerRelay`. Switch the
  connect route to the new `hello`. Move Fly to connect mode. Delete
  `computerd`. Live check: a self-hosted container passes the existing
  `computer_*` acceptance list.
- **P2, images.** `agent_images`, MCP image blocks, content parts in the
  runner, limits and trimming, and `browser_screenshot` on the new path. Live
  check: on each runtime that P0 allowed, the agent describes a screenshot
  correctly.
- **P3, desktop ops.** Desktop ops in the relay, the lease, the `computer_*`
  desktop tools, migration 0024, and the agent dialog switch. Live check: the
  agent opens Chromium in the desktop image and finishes a short web task.
- **P4, people.** Desktop routes with the Origin check, the Screen tab,
  take-control and hand-back, `request_human_takeover`, the takeover card and
  activity thumbnails. Live check: the agent asks for a takeover, a second
  browser session takes control, hands back with a note, and the agent
  continues.
- **P5, acceptance.** Production, a machine started with the desktop image,
  the full round trip on both runtimes where P0 allowed it. Screenshots in
  `docs/acceptance/remote-desktop/`.

## Work split

P1 and P2 do not touch the same files and can run as two parallel tracks with
explicit file ownership: P1 owns `apps/computer`, `modules/computer/` and the
connect route, while P2 owns `modules/mcp/format.ts`, `modules/runner/` and the
image store. P3 and P4 are sequential after both. Run a full typecheck and a
re-review on the merged result, not only per track.

## Risks

TrueForge lessons this port must keep, by number from the fork's report:

1. Freeze the wire as golden fixtures both sides test, and add fields only
   behind a capability.
2. On a hibernating DO, keep only in-flight state in memory. Everything else
   goes to storage, and stored values are re-parsed.
3. Random request ids, sockets picked by generation, staleness polled inside
   the waiting request, last-seen written from an alarm.
4. Decide the lease before any `await`. A person in control blocks `exec`
   too.
5. Every "retry until done" state needs an exit (the 3-failure clipboard
   cutoff).
6. Don't collapse daemon error codes at the relay (fixed in decision 4).
7. Commands outlive the socket. A reconnect must not kill running work.
8. Enforce every provider image limit at write time, and stub rather than fail.
9. Test Origin and auth checks through the real runtime. `wrangler dev`
   rewrites `Origin`.
10. Pause, don't unmount, a view whose unmount hands back control.
11. Typecheck and re-review the merged branch. Bun's test runner, like vitest,
    does not typecheck.

Risks specific to Agentum:

- **The managed runtime may not see images.** If spike 1 fails, managed agents
  get no desktop, only the screen for people to watch. That is a product
  decision to make after P0, not during P3.
- **Workers AI vision models may be weak at UI work.** Coordinates from a
  small vision model can be off. The acceptance runs use an Anthropic model
  through AI Gateway first.
- **Long MCP requests on Managed Agents.** The cycle 17 note still stands:
  holding one MCP request open for a long `exec` is unverified. Desktop calls
  are short (2 to 5 s), so they are lower risk.
- **Fly stays unverified.** Moving it to connect mode does not make it tested.
  Keep it unadvertised until it runs on a real account.
- **Token in a `docker run` line.** The one-time token is the long-lived
  credential (decision 5). Rotation is the remedy. Revisit enrollment codes
  if hosts start being shared.
- **Two copies of reserved-range checks already exist** (cycle 18). The
  desktop work adds no outbound fetches, so it should not add a third.
