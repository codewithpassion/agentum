# Agentum — Design Spec (Phase 1)

GrokBot-inspired workspace for Anthropic managed agents. Reference:
[grokbot.png](grokbot.png). Plan: [plan.md](plan.md).

## 1. Layout

One full-viewport shell at `/`, three panes, no page scroll — only the panes
scroll. Nothing shifts when Phases 2–3 land, because the rail is already there.

```
┌──────────────┬───────────────────────────────┬──────────────────┐
│ Sidebar 280px│ Conversation (flex-1, min-0)  │ Agent rail 320px │
│              │                               │  (collapsible)   │
│ workspace    │ header: name · members        │ avatar + name    │
│ search       │ ───────────────────────────── │ status: idle     │
│ CHANNELS  ＋ │ message stream (scrolls)      │ Screen│Files│Act │
│ DMs          │  ▸ bubbles, md, attachments   │   (disabled)     │
│ Wiki (soon)  │  ▸ "N replies" → thread panel │ Soul             │
│ ─────────────│ ───────────────────────────── │ Instructions     │
│ user · theme │ composer: ＋ · @ · Enter=send │ Edit · Delete    │
└──────────────┴───────────────────────────────┴──────────────────┘
```

- The thread panel opens **between** the conversation and the agent rail
  (`22rem`), so a reply never hides the channel it belongs to. Its own composer
  posts with `threadParentId`.
- The rail is toggled by "Agent screen" in the channel header and hides itself
  below `lg`, where the conversation needs the width more.
- Selection lives in the URL search params of `/` (`?channel=…&agent=…`) —
  refresh-safe and shareable, while still only ever produced by clicking. The
  open thread is local state keyed by channel, so leaving a channel closes it.

## 2. Navigation model (non-negotiable)

Every Phase 1 feature is reachable by visible clicks from the shell:

| Feature | Path through the UI |
|---|---|
| Open channel | sidebar → Channels → row |
| Open DM with agent | sidebar → Direct messages → agent row (DM created on demand) |
| Create channel | sidebar `＋` → "New channel" → name + member picker |
| Create agent | sidebar `＋` → "New agent" → name/soul/instructions |
| Edit/delete agent | agent rail → Edit / Delete (confirm dialog) |
| Agent profile | click an agent in the sidebar, or its avatar on a message |
| Thread | message → "N replies" / "Reply" |
| Attachments | composer `＋` → file picker → pending chips → send |
| Mentions | composer → `@` → autocomplete popover |
| Theme | sidebar footer toggle |
| Wiki | sidebar link, disabled with a "Phase 2" hint |

## 3. Colour

Dark-first, near-monochrome like GrokBot: colour is reserved for agent
identity, never for chrome. Tokens are `--ws-*` in `src/styles.css`, defined
for dark (default) and light, driven by the existing `data-theme` /
`prefers-color-scheme` mechanism, so `ThemeToggle` keeps working untouched.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--ws-bg` | `#0a0a0b` | `#f7f7f8` | app background |
| `--ws-panel` | `#111113` | `#ffffff` | sidebar, rail |
| `--ws-surface` | `#18181b` | `#f0f0f2` | bubbles, inputs, cards |
| `--ws-surface-hover` | `#212125` | `#e7e7ea` | hover/active rows |
| `--ws-line` | `#26262b` | `#e2e2e6` | 1px borders |
| `--ws-text` | `#ededef` | `#18181b` | primary text |
| `--ws-muted` | `#8f8f98` | `#65656d` | timestamps, meta |
| `--ws-accent` | `#5b8cff` | `#3057d6` | own bubble, focus ring, mentions |

Agent avatars use the deterministic hex from `avatarForName` (agents module) as
background with white initials — the one place hue appears.

## 4. Typography & spacing

- Single family: the existing `Manrope` (`--font-sans`). No display serif in the
  workspace — GrokBot is utilitarian.
- Scale: `11px` meta/labels (uppercase, `tracking-wide`), `13px` sidebar rows and
  composer, `14px/1.6` message body, `15px` headers. Names are `600`, body `400`.
- Spacing: 4px base. Sidebar rows `px-2 py-1.5`, gap `2px`; message rows `py-1.5`
  with `gap-3`; pane padding `px-4 py-3`. Bubbles `px-3.5 py-2.5`,
  `rounded-2xl`, `max-w-[min(680px,72%)]`.
- Radii: `rounded-lg` controls, `rounded-2xl` bubbles/dialogs, `rounded-full`
  avatars and chips. Borders over shadows; the only shadow is on dialogs.

## 5. Message rendering

- **Alignment**: current user right (accent bubble, `.ws-own`), everyone else
  left (`--ws-surface`). Own = `authorType === "user" && authorId === clerkUserId`.
  `.ws-own` inverts link and code styling, which would otherwise vanish against
  the filled accent background.
- **Author chip**: avatar + name + `HH:MM` above the bubble, hidden when the
  previous message is from the same author within 5 minutes (grouping). An
  agent's chip is a button that opens its profile in the rail.
- **Markdown**: `react-markdown` + `remark-gfm`, no raw HTML (no `rehype-raw`),
  so message bodies cannot inject markup. Links get
  `target="_blank" rel="noopener noreferrer"`. Styled through a small
  `.md-body` rule set rather than `@tailwindcss/typography`, which is tuned for
  documents, not 14px bubbles.
- **Attachments**: `image/*` render inline (max 320px tall, click opens the
  original); everything else becomes a document chip (icon, filename, size)
  linking to `/api/attachments/:id`, which sets `Content-Disposition`.
- **Threads**: a footer button "N replies" under the parent, plus "Reply" on
  hover. Replies never appear in the main stream (the API already excludes
  them).

## 6. Realtime

One WebSocket per open channel (`GET /api/channels/:id/ws`), opened on channel
switch and closed on leave. Incoming `message.created` events are merged into
the stream keyed by message id, so the POST response and the broadcast converge
on one entry. Events with `threadParentId` bump the parent's reply count and, if
that thread is open, append to it.

## 7. Component inventory

`src/components/ui/` — hand-rolled primitives (dark-first, no dependency):

| Component | Notes |
|---|---|
| `button` | variants `primary`, `subtle`, `ghost`, `danger`; sizes `sm`, `md`, `icon` |
| `field` | `TextField` / `TextAreaField` — labelled, focus ring `--ws-accent` |
| `dialog` | native `<dialog>` — focus trap and Escape come free |
| `popover` | absolutely positioned, closes on outside pointer-down / Escape |
| `avatar` | colour + initials, sized `sm` / `md` / `lg` |

Scrolling uses plain `overflow-y-auto` containers; a scroll-area primitive
would have earned nothing here.

`src/components/workspace/`:

| Component | Responsibility |
|---|---|
| `workspace.tsx` | shell: layout, selection, dialogs, data loading |
| `sidebar.tsx` | search, channels, DMs, `＋` menu, wiki link, footer |
| `channel-dialog.tsx` | channel name + agent member picker |
| `agent-dialog.tsx` | create/edit agent (name, soul, instructions) |
| `confirm-dialog.tsx` | delete confirmation |
| `conversation.tsx` | channel header, member avatars, composer wiring |
| `message-stream.tsx` | grouping, load-older, scroll anchoring |
| `message-item.tsx` | bubble, author chip, thread footer |
| `attachments.tsx` | inline images and document chips |
| `markdown.tsx` | `react-markdown` + `remark-gfm` wrapper |
| `composer.tsx` | textarea, Enter/Shift+Enter, attach, mention popover |
| `thread-panel.tsx` | parent + replies + its own composer |
| `agent-rail.tsx` | identity header + Screen/Files/Activity/Profile tabs |

`src/lib/`: `api.ts` (typed fetch wrappers over `/api`, aliasing the server's
`MessageView` / `ChannelMemberView` / `Agent` types via `import type`, so the
client cannot drift from the API), `use-workspace-data.ts`, `use-conversation.ts`,
`use-channel-socket.ts`, `authors.ts` (message → display identity),
`mention-input.ts` (pure autocomplete helpers, unit-tested), `format.ts`
(time, file size, initials), `cx.ts`.

## 8. Deliberately out of scope for Phase 1

Unread badges (no API), presence, message edit/delete, channel delete UI,
optimistic sends, socket reconnection beyond reopen-on-channel-switch, infinite
scroll (a "Load older" button instead), search across message bodies (the
sidebar search filters channels and agents only), and highlighting mentions
inside a rendered body — the server already parses and stores them, which is
what phase 2 routing needs.

**Component library:** shadcn/ui was skipped. Its CLI rewrites `styles.css`
with its own token set, which would have collided with the existing theme
tokens and the working theme toggle. The six primitives above are hand-rolled
against the `--ws-*` tokens instead — far less code than the collision would
have cost to unpick.
