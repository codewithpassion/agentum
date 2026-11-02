# The rail: spec

Direction A from `docs/ux-review/review.md`, built for several agents and several people. The clickable design is `docs/ux-review/rail/design.html`. Open it with `?who=dan` or `?scope=everyone` to see other states. Where this file and the design disagree, this file wins.

## What changes for a person

The sidebar stops being a list of pages and becomes the work. A person sees what waits on them, in plain words, sorted by when it's due. They open an item in the main pane and decide there. Running work shrinks to a dim line. Everything that exists today stays reachable through Find.

Colour, fonts and spacing tokens stay as they are in `apps/web/src/styles.css`.

## Rules

1. **Each agent asks one person.** `agents.owner_user_id`, falling back to `agents.created_by`. Optionally a backup, `agents.backup_user_id`.
2. **Mine and Everyone.** The rail opens on Mine. Mine holds items whose agent's owner is me, items escalated to me, and items with nobody to ask. Mine also holds items whose assignee cannot see them, for the person who can: a run in the viewer's own `ui` or private session on an agent someone else owns. An owner who is no longer a member of the Clerk organisation counts as nobody, so nothing gets orphaned. If the member lookup fails, Mine shows everything, because hiding work is worse than showing too much. Everyone holds all items, each naming who it's for.
3. **This is visibility, not permission.** Any member can still answer any request, and the existing authorisation doesn't change. A session's existing visibility rules still apply to runs.
4. **Escalation is computed on read.** An item older than `RAIL_ESCALATE_AFTER_MS` (4 hours) also appears in the backup's Mine, marked "asked you too". No cron and no new state.
5. **Plain titles.** No card, in the rail or on the Board, shows "Inbound mail. The quoted JSON below...". A run started by mail takes its title from the mail subject, with leading `Re:` and `Fwd:` removed.
6. **Sort by due, then age.** Needs you sorts by `dueAt` when known, soonest first, with undated items after, oldest first. `dueAt` comes from a small text parser. It's a heuristic, and when it finds nothing the item keeps its age order.
7. **Grouping.** Two or more open mail approvals to the same outside domain become one rail row, with the others under it in the pane. Domains of common free mail providers group by full address. Nothing else groups.
8. **Hand-offs.** A run whose `parent_run_id` is set, or whose actor is an agent, says "passed on by <agent>". The parent has usually finished by then, so there's one live row for the work.
9. **Stuck work needs you.** A run that finished in the last 7 days as `failed` or `interrupted`, or that has a bounced outgoing mail, is a Needs you item until someone dismisses it (`runs.attention_cleared_at`).
10. **The list holds still while you read.** New items never move the open item. See `stableOrder` below.
11. **Mail approvals wait longer.** Mail approvals get `MAIL_APPROVAL_TTL_MS` (3 days) because they don't block a running tool. Other approvals keep the 1 hour limit. The expiry shows only under 4 hours left.
12. **Setup is items.** A workspace with no model key gets "Add your AI account" at the top of Needs you. A workspace with no active agent gets "Describe your first job". Each disappears when done.

## Data contract (RL.1)

Schema, one migration with `bun run generate` in `packages/db`:

```ts
// agents
ownerUserId: text("owner_user_id"),   // Clerk user id. Null means created_by.
backupUserId: text("backup_user_id"), // Clerk user id. Null means no backup.
// runs
attentionClearedAt: text("attention_cleared_at"),
attentionClearedBy: text("attention_cleared_by"), // Clerk user id.
```

In `packages/db/src/shared.ts`, importable from the browser:

```ts
export const RAIL_ESCALATE_AFTER_MS = 4 * 60 * 60_000;
export const MAIL_APPROVAL_TTL_MS = 3 * 24 * 60 * 60_000;
export const RAIL_REFRESH_EVENT = "hm:rail-refresh"; // window event: refetch the rail now
export type RailScope = "mine" | "everyone";
export type RailItemKind = NeedsYouKind | "problem";

export interface RailMail {
  body: string;        // the reply a person is approving, up to 4000 characters
  subject: string;     // without Re: or Fwd:
  theyWrote: string | null; // snippet of the inbound message on the same thread
  to: string[];
}

/** One decision. A rail row holds one, or several when grouped. */
export interface RailCard {
  agentId: string;     // "" when no agent is involved
  agentName: string;
  at: string;
  detail: string;      // the desk card's band text: version message, skill name, reply text. On a problem, the sentence that says what happened
  expiresAt: string | null;
  id: string;          // the source card's id, so request ids stay answerable
  kind: RailItemKind;
  mail: RailMail | null;
  passedOnBy: string | null;
  runId: string | null;
  status: string;      // what happened, in plain words: "Reply ready"
  threadId: string | null;
  title: string;
}

export interface RailItem {
  assigneeName: string | null;   // null means anyone
  assigneeUserId: string | null;
  cards: RailCard[];             // at least one; the first gives the row its title
  dueAt: string | null;
  escalatedToMe: boolean;
  id: string;                    // stable across polls: the first card's id
  mine: boolean;
}

export interface RailWorking {
  agentId: string;
  agentName: string;
  id: string;          // run id
  mine: boolean;
  passedOnBy: string | null;
  status: string;
  title: string;
}

export type RailSetupStep = "ai_account" | "first_agent";

export interface RailView {
  counts: { everyone: number; mine: number }; // Needs you, for the badge and the toggle
  doneToday: number;      // finished today within the scope
  needsYou: RailItem[];   // already filtered to the scope and sorted
  setup: RailSetupStep[];
  working: RailWorking[]; // already filtered to the scope, newest first
}

export interface WorkspaceMember {
  name: string;
  userId: string;
}
```

## Service and API (RL.2)

New module `packages/services/src/rail.ts`, exported as `@repo/services/rail`, with `createRailService({ agents, clock, db, desk, members, modelKeys..., people })`. It follows the factory rule: no `env`, built in `composeWith`.

`rail.get(principal, { dayStart, scope })` returns `RailView`. It reads through the desk service so the visibility rules stay in one place. Add whatever narrow read the desk needs to expose instead of duplicating its queries.

Pure helpers live beside it with table tests, in `packages/services/src/rail/logic.ts`:

- `dueFrom(text, { dayStart, messageAt })` returns an ISO time or null. It handles `urgent`, `asap` and `today` (end of the message's day), `tomorrow` with an optional time (`by 9am tomorrow`), `by <weekday>`, and `by 30 November` with an optional year. Past dates still return, and sort first. It looks at the subject and inbound text. `dayStart` is the viewer's midnight, which gives their timezone.
- `mailTitle(subject)` strips any run of leading `Re:`, `Fwd:` and `Fw:`, case-insensitive.
- `groupKey(toAddresses)` returns the outside domain, or the full address for a free mail domain.
- `plainStatus(card)` and `plainTitle(card)`. A mail approval is titled `Reply to <first name or address>: <subject>` with status `Reply ready`. Any other approval is titled `<agent> asks before <label>`, using `PLATFORM_TOOL_LABELS`, falling back to the tool name without its prefix. Question, takeover and proposal kinds keep their existing titles and use the wording of `HEADINGS` in `needs-you-card.tsx` as the status, moved to `@repo/db/shared` so the service and the Board share it.
- `isMine`, `isEscalated` and `sortNeedsYou`.

Other service changes:

- `desk.get`'s `titleOf`: a run with an inbound mail message shows `mailTitle(subject)`. Add a test that the words "quoted JSON" never reach a card.
- `requests.open` takes an optional `ttlMs`. `mail/outbound.ts` passes `MAIL_APPROVAL_TTL_MS`.
- `agents.setOwners(principal, agentId, { ownerUserId, backupUserId })`, which writes an audit event the way other agent updates do. Each id must be a current member, and owner and backup must differ.
- `rail.clearAttention(principal, runId)`.
- A `MemberDirectory`-style port lists a Clerk organisation's members. The Clerk call lives in `apps/web/src/server/`, alongside the current `memberDirectory`. Tests pass a fake.

tRPC: `desk.rail` (query), `desk.clearAttention` (mutation), `members.list` (query), `agents.setOwners` (mutation). Routers stay thin. Add `rail` to `Services` and to `composeWith`.

`desk.needsYouCount` stays as it is for other callers.

## The shell (RL.3)

`apps/web/src/components/rail/`, with `index`-free imports per the repo's no-barrel rule. `_app.tsx` renders `Rail` in place of `AppSidebar`, inside the same `SidebarProvider`, so the mobile sheet and the toggle keep working. Remove `AppSidebar` and its menu links when nothing uses them. Pinned artifacts stay, as a small group above the foot links.

Layout, top to bottom, at 320px wide on desktop:

- Workspace name, on its own row. It opens the workspace menu, see below. Board, Find and New are not here: they sit on the right of the top bar, before the user button, in that order. Board links to `/desk?view=board` and is `aria-current` there. `New` opens a small menu under the button: New task, New agent. It reuses `NewTaskDialog`. Below `md` the three show icons only, with `aria-label`s.
- The Mine and Everyone toggle, with its count on each side. It's stored in `localStorage` as `hm:rail-scope`. Hidden when the workspace has one member.
- **Needs you** with its count. Each row is a link to `/desk?item=<id>`. It shows the title, the agent tile, the due label, the status, `+N more` when grouped, `for <name>` in Everyone, and `asked you too` when escalated. `problem` rows use the destructive colour on the left edge. Setup steps show here first, with links to `/settings/model-providers` and `/agents/new`.
- **Working** with its count. At most 3 dim one-line rows with a slow pulse. A `N more working` row expands the rest. The status shows only on hover or in the title attribute.
- `N done today`, a link to `/desk?view=board`.
- Foot: `Agents`, `Files`, `Everything`.

Data: one `useRail(scope)` hook on `usePolledQuery` with `DESK_POLL_INTERVAL_MS`, which also refetches on `RAIL_REFRESH_EVENT`. `stableOrder(previousIds, nextItems, openId)` in a pure tested file keeps the open row where it is: if the open row is still present, it holds its position and the rest sort around it. New rows get a one-time rise animation, off under `prefers-reduced-motion`.

`Everything` and `Ctrl/Cmd+K` open a `CommandDialog` from `components/ui/command.tsx`. It lists every route the sidebar and Settings list today, using today's page names plus a plainer word where it helps: Board (Desk), Agents, every agent by name, Map, Q&A, Library, Artifacts, Skills, Machines, Inbox, Sessions, Log, Routines, Triggers and each Settings page. A test in the style of `nav-registry.test.ts` compares the list against the route files, so no page is dropped.

On phones the rail opens in the existing sheet, and `/desk` with no `item` shows the same list inline.

## The workspace menu (WS.2)

`apps/web/src/components/rail/workspace-menu.tsx`. The workspace name opens a menu. It lists the person's workspaces and marks the current one. The server's `workspaces.mine` decides which ones show, so only organisations with a `workspaces` row appear. Other apps' organisations on the shared Clerk instance never show. Names come from Clerk on the client, so a rename shows at once.

`Manage members` opens Clerk's organisation profile, for the member list, roles, pending invitations and revoking. Any member can open it, and Clerk limits what a non-admin can change. The app opens it with `appearance.elements.membersPageInviteButton` set to `display: none`, so nobody sends Clerk's own invitation, which carries no redirect URL. `New workspace` shows only to an org:admin of the current workspace. The server enforces the same rule in `workspaces.createFromSession`. It creates the Clerk organisation with the caller as admin, turns off admin delete on it, then inserts the row. If the insert fails, it deletes the organisation.

`Invite people` shows only to an org:admin of the current workspace, and opens a dialog with an email address and a role (`Member` by default, or `Admin`). `workspaces.inviteFromSession` enforces the same rule on the server: a browser session of an org admin, a valid address, and the organisation taken from the caller's workspace, never from the client. It sends the invitation through Clerk's Backend API with the caller as `inviterUserId` and a `redirectUrl` of `PUBLIC_BASE_URL/accept-invitation?org=<organisation id>`. An address that is already a member gets "is already a member of this workspace". Clerk replaces a pending invitation for the same address with a new one, so a second send re-issues it and revokes the old link.

The email link goes through Clerk and arrives at `/accept-invitation` with `__clerk_ticket`, `__clerk_status` (`sign_up` or `sign_in`) and `org`. A signed-out visitor sees `<SignUp>` for `sign_up` and `<SignIn>` for `sign_in`, and each form spends the ticket itself. Both return to `/accept-invitation?org=...`. There a signed-in session first asks the server (`workspaces.hasWorkspace`) whether the organisation has a `workspaces` row. With no row it shows "This invitation is not for the account you are signed in with." and does nothing else: no accept, no `setActive`. A member of an organisation with a row gets `setActive` and `/desk`. A person who was already signed in when they opened the link, so no form spent the ticket and the invitation is still pending, sees the organisation's name and a `Join` button, and the invitation is accepted only on that click, with or without a ticket in the link, because the route cannot verify a ticket on a signed-in session. Then `setActive` and `/desk`. A person who belongs to several organisations therefore lands in the inviting one. A link with no ticket, such as a reload after use, shows `<SignIn>`. `/sign-up` and `/login` are untouched.

Switching workspace ends in a full page load to `/desk`. Loaders, polls and the rail hold the old workspace's data, so a soft navigation would show it. A failed switch stays where it is and shows the error.

This is not Clerk's `OrganizationSwitcher`. That lists other apps' organisations, and its create button makes an organisation with no workspace row.

`NoAccess` on `/` (`apps/web/src/routes/index.tsx`) shows the same list under "<org> has no Harbourmaster workspace", plus Sign out.

`Members` and `New workspace` are not in Find. Find lists plain routes, and both are actions (a Clerk modal and a dialog), so they stay in the menu. `/choose-organization` is our own list of the person's organisations that have a `workspaces` row (`workspaces.mine`). It offers no create and lists no invitations. Choosing one calls `setActive`, then loads the `redirect` page, or `/desk`.

## The main pane (RL.4)

`apps/web/src/routes/_app/desk.tsx`, with new components in `apps/web/src/components/rail-pane/`.

Search params: `item`, `view` (`board`), and the existing `agent`. `view=board` renders today's desk, unchanged except for titles. With no `item`, the pane shows the first item in the current scope, or "Nothing needs you" with a count of what's in hand. It reads `desk.rail` with its own poll.

An item shows each of its cards in order:

- **Mail approval.** Heading is the card title. `They wrote` quotes `theyWrote`. The reply is `mail.body` in the body font, not monospace. It lists who it goes to. Buttons: `Send reply` (allow once), `Not this time` (deny, with an optional note labelled "Tell it what to change"), and a quiet `Always send to this address` (always allow). Answers go through the existing `requests.answer`, and a failed send shows the same error the Desk shows today. `Waiting on <name>` sits on the right, and the expiry appears only when under 4 hours are left.
- **Other kinds.** Reuse `NeedsYouBody` from `needs-you-card.tsx`, exporting it, inside the same heading. It keeps every existing behaviour for questions, takeovers, proposals, conflicts and suggestions. `RequestCard` drops the raw `Use <tool>` heading in favour of the card title when one is passed.
- **Problem.** Says what happened in one line, with `Open the log` and `Dismiss` (`desk.clearAttention`).
- **Setup.** `?item=setup:ai_account` and `?item=setup:first_agent` show one short explanation and a button.

Every card ends with a collapsed `How it got here`: who or what started it, and when, with a link to `/tasks/$runId` as `Open the full log`.

After any action, dispatch `RAIL_REFRESH_EVENT` and move on to the next item.

## Agents and asking (RL.5)

- `/agents` becomes a table: name, who it asks, what it's doing now (`N waiting`, `N working` or `Quiet`), and tasks this week. Add `rail.agentsOverview` if the existing list can't supply this. Show cost only if a per-run cost is already stored and cheap to sum, otherwise leave it out and say so in the review file.
- The profile gets an `Asks` row, with an owner select and a backup select from `members.list`, saving through `agents.setOwners`. With one member, it shows the name as plain text.
- The builder's missing-key error links to `/settings/model-providers`.
- The builder keeps its description in `sessionStorage`, so it survives a trip to Settings. It clears on create or discard.

## Not in this milestone

The sentence from direction C, the morning note, teams, a workspace timezone, one-click Google, a starter credit, removing the Task page's duplicate panels, and editing a reply before sending it. Each is worth doing, and none is needed for the rail to work. Reply editing would need a change to how approved input reaches the mail tool.

Production stays where it is until Dom says otherwise.

## Done means

- Priya with several agents sees only her items on Mine, and Dan sees his.
- An approval older than 4 hours appears for the backup.
- Mail tasks read as their subject everywhere.
- A new mail arriving while Priya reads doesn't move what she's reading.
- A failed run appears in Needs you until dismissed.
- A brand new workspace sees the two setup steps.
- Every page reachable before is reachable through Find.
- `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` stays clean.
