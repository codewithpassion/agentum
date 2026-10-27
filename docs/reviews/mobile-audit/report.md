# Harbourmaster mobile audit (staging)

Target: https://harbourmaster-staging.rockyshoreslabs.io, Dev Workspace. Viewport 390x844 with DPR 3 and an iPhone Safari user agent, spot checks at 360x740. All screenshots are in this folder (`/home/roboto/devel/harbourmaster-wt/tmp/mobile-audit/`). No code changed, nothing committed or deployed.

Limits of the method (headless Chrome through agent-browser):
- `navigator.maxTouchPoints` was 0, so real touch events were not emulated. Taps were mouse clicks.
- The on-screen keyboard cannot be emulated. Keyboard findings are inferred from font sizes and layout (page height 664px is the usable height on iPhone Safari, so dialogs were judged against that).
- iOS input zoom is judged from computed font size under 16px on real inputs, textareas and native selects.

## Incident, read first

While probing the API keys page I clicked "Revoke" with a text-match helper and it revoked the API key `x2-staging-check` (desk access, test data) with no confirm step. This cannot be undone from the UI (a new key has to be created). Nothing else was saved, deleted or sent. One other state change was made and undone: the "Attach" button on the bruce-ops computer card attached the `morosini` computer, and I clicked "Detach" to restore it. F-24 below is the missing confirm that caused the first one.

## Coverage

Routes in `apps/web/src/routes`: ok means no finding.

| Screen / dialog | Result |
|---|---|
| App shell, header, sidebar sheet, "More" group, user menu (Clerk) | F-01, F-02, F-23 |
| `/desk` (lanes, agent filter chips, needs-you cards, Done cards) | F-03, F-23 |
| Desk "+ New task" dialog | ok (16px textarea, fits) |
| Desk "See changes" and Approve/Reject on skill proposal | links to skill page, F-23 (Approve/Reject not pressed) |
| `/agents` list | ok |
| `/agents/new` (draft form, template chips) | F-23. "Draft" and "Import from a file" not run (calls the model / opens a file picker) |
| `/agents/$agentId` profile page | F-04, F-05, F-06, F-23 |
| Profile: Edit sheet (name, instructions, model, runtime, network, turn limit, Save, Archive) | F-07, F-08 |
| Profile: Tools sheet (connectors, secret grants) | F-09 |
| Profile: Skills sheet | F-09, F-07 |
| Profile: Hands to sheet | F-10 |
| Profile: Starts on sheet (triggers, routines) | F-09, F-11 |
| Profile: Mail / Channels sheet | ok (empty) |
| Profile: Add folder picker dialog | ok (28px rows, F-23) |
| Profile: Reserve address inline editor | ok |
| Profile: Voice field, Browser switch, Ask-before switches | F-06, F-23 |
| Profile: Computer card (Attach / Detach) | ok on layout, see Incident |
| Profile: Run now, Archive agent confirm, Advanced runtime picker | not opened (Run now sends a task; Archive is destructive). Advanced opens the Edit sheet |
| `/sessions` (agent and origin filters, list) | F-07 |
| `/tasks/$runId` (receipt, computer, files, action log, thread) | F-12, F-13, F-23 |
| Task: tool-call cards, Edit and resend inline editor, From library picker | ok layout, F-13 |
| Task: approval and question cards | not reachable, see below |
| Task: computer / takeover view (`desktop-screen.tsx`) | not testable, F-14 from code |
| `/inbox` (new thread form, thread list, thread, composer) | F-15 |
| `/log` (filters, wide table, pager) | F-07, F-16 |
| `/library` (wiki card, upload, new folder, table, rename, move, file panel) | F-17, F-16, F-23 |
| Library: Rename dialog, Move dialog, New wiki page dialog | F-07 for the Parent select, close X 28px (F-23) |
| Library: Delete, Upload (file picker), wiki page view, history panel | not exercised (destructive / native picker / no wiki pages exist) |
| `/map` read mode | F-18 |
| `/map` editor mode (palette, node selection, wires, + Trigger) | F-18, F-19, F-20 |
| `/qa` list, filters, Ask dialog | ok |
| `/qa/$questionId` | ok, F-23 |
| `/skills` list and create / upload / import forms | F-21 |
| `/skills/$skillId` Files tab, History tab, Review panel | F-07, F-23. Approve/Reject not pressed |
| `/routines` table and Create routine dialog | F-16, F-22, F-24 |
| `/triggers` table and Create trigger dialog | F-16, F-07, F-24 |
| `/settings` and `/settings/model-providers` | F-25 |
| `/settings/machines` (also `/machines`) and Add computer / Enrol dialogs | F-16, F-25, F-26 |
| `/settings/connectors` (also `/connectors`), Add connector, Time limit dialogs | F-16, F-25 |
| `/settings/secrets`, New secret, Replace value, Edit hosts, Edit rules | F-16, F-25, F-23 |
| `/settings/api-keys`, Create key dialog | F-16, F-24, F-07 |
| `/settings/connected-apps` | ok (empty), F-25 |
| `/settings/managed-agents`, `/settings` index | redirect only |
| `/login`, `/sign-up`, `/choose-organization`, `/dev-login`, `/` | not audited (Clerk hosted UI and redirects) |
| Settings "Members" | no such route exists in the app |

## Findings

Severity: blocker = a function cannot be done on a phone, major = possible but painful, minor = cosmetic. Paths are under `apps/web/src/`.

| ID | Screen / dialog | Problem | Sev | Screenshot | Likely component |
|---|---|---|---|---|---|
| F-01 | App shell, sidebar sheet | After tapping a nav link or agent in the mobile menu, the sheet stays open and covers the new page. The user has to tap outside it every time. | major | nav-sheet-stays-open-after-navigation.png | components/shell/app-sidebar.tsx (links need `setOpenMobile(false)` from `useSidebar`, since the primitive in ui/sidebar.tsx cannot be edited) |
| F-02 | App shell | The menu button is a 28px icon under the header, inside a separate 48px empty bar, so there are two stacked bars. "More" group (Inbox, Sessions, Log, Routines, Triggers) is collapsed and sits below the 10-agent list, so those pages need a scroll plus an expand. Rows are 32px. | minor | nav-sidebar-sheet.png | routes/_app.tsx (SidebarTrigger bar), components/shell/app-sidebar.tsx (MoreSection) |
| F-03 | Desk | Card titles ("Run the skill ...", "Inbound mail. The quoted JSON b...") are cut to one line with no expand. The Done lane lists 52 cards in one long column with no paging or collapse. Agent filter chips and Approve / See changes / Reject buttons are 28px high and about 8px apart. | minor | desk-needs-you-cards-truncated-titles.png | components/desk/desk-card.tsx, needs-you-card.tsx, desk-lane.tsx, proposal-actions.tsx |
| F-04 | Agent profile | Page-level sideways scroll. On 390px a long "Starts on" chip ("weekdays at 07:00 Australia/Sydney · paused", `whitespace-nowrap`) is wider than the card: docW 415 and 434 on two agents, 384 on a third at 360px. The chip text is cut, so the schedule status cannot be read. | major | agent-profile-390-sideways-scroll-vm-agent.png, agent-profile-360-page-sideways-scroll-schedule-chips.png | components/agent/profile/chip-list.tsx (CHIP class), mail-start-chip.tsx, profile-rows.tsx |
| F-05 | Agent profile | Two-column label/value rows keep a roughly 110px label column, so values get about 210px. The "Does" instruction is clamped to 4 lines with no expand. The library row path wraps mid-word ("agents/morni ng-sweep"). | minor | agent-profile-two-column-rows-chips-overflow.png | components/agent/profile/profile-row.tsx, profile-rows.tsx, library-row.tsx |
| F-06 | Agent profile | Browser switch is 24x14 and the grant/ask switches are 32x18 with 28px rows. Chips ("+ Add tool", "+ Add skill", "Manage") are 22px high. The "Emails someone outside the workspace" row wraps its value to "Alwa / ys". | minor | agent-profile-approval-row-always-wraps.png | components/agent/profile/browser-switch.tsx, ask-before-card.tsx, chip-list.tsx |
| F-07 | Many forms | Native selects render at 14px, so iOS zooms the page on focus. Affects: Log (agent, type), Sessions (agent, origin), Skill History compare, agent Edit sheet (model, runtime, isolate), Skills sheet version pickers, Create routine (agent, schedule), Create trigger (agent), Create key (access), New wiki page (parent). | major | log-table-wide-horizontal-scroll.png, agent-edit-sheet-bottom.png | cause: ui/native-select.tsx (`text-sm`, CLI output). Callers to fix with a `text-base md:text-sm` class: log/log-filters.tsx, sessions/session-filters.tsx, routines/create-routine-dialog.tsx, triggers/create-trigger-dialog.tsx, agent/agent-form.tsx, agent/profile/sheets/connectors.tsx, api-keys/create-key-dialog.tsx, library/wiki-new-page-dialog.tsx, skills/skill-history.tsx |
| F-08 | Agent Edit sheet | Works (scrolls), but is 75% width (about 290px) and carries a 1347px form. Network access switch is 32x18. Save and Archive are at the very bottom. | minor | agent-edit-sheet-bottom.png | components/agent/agent-form.tsx, agent/profile/manage-sheet.tsx |
| F-09 | Agent sheets (Tools, Skills, Starts on) | Sheets are 290px wide. The Tools secrets table is clipped on the right (Mode column cut), the Skills version select overflows the edge, and the Starts on routines table shows only the Name column, so Pause/Remove and schedule columns are off-screen sideways. | major | agent-tools-sheet-narrow-table-clipped.png, agent-skills-sheet-narrow-select-overflow.png, agent-starts-on-sheet-routines-actions-clipped.png | components/agent/profile/manage-sheet.tsx (SheetContent default `w-3/4`), sheets/secrets.tsx, sheets/secrets/secret-row.tsx, sheets/connectors.tsx |
| F-10 | Hands to sheet | Checkboxes are 16px with 28px row pitch. | minor | agent-hands-to-sheet-16px-checkboxes.png | components/agent/profile/sheets/hands-to.tsx |
| F-11 | Starts on sheet | See F-09 and F-16: routines table inside a 290px sheet. | major | agent-starts-on-sheet-routines-actions-clipped.png | components/routines/routine-table.tsx via agent/profile/sheets |
| F-12 | Task page | Title is cut with "..." at 3 lines, the receipt message bodies are clamped (the last line is cut mid-sentence) and the fact chips wrap into five rows. Breadcrumb "Desk" is 32x18 and "Stop task" 80x28. | minor | task-header-title-truncated.png | components/task/task-page.tsx, receipt.tsx |
| F-13 | Task thread composer | Textarea is `text-sm` (14px), so iOS zooms on focus. The composer sits at the end of the page and is not sticky, so a long thread means scrolling to the bottom to reply and the keyboard may hide it. Hint says "⌘+Enter to send", which does not exist on a phone, and Enter inserts a newline. Buttons are 28px. | major | task-thread-composer-14px-not-sticky.png | components/thread/composer-container.tsx, send-hint.tsx |
| F-14 | Task computer (takeover) | Could not test, the desktop was offline ("Connection lost"). From code: pointer events with `touch-none` on the frame, only a wheel listener for scrolling and `contextmenu` for right click, so there is no touch scroll, drag or right click gesture. Keyboard is a 1px hidden textarea driven by `onKeyDown`, which iOS virtual keyboards report poorly and which is probably under 16px. Likely a blocker for taking over on a phone. | major (unverified) | none (screen offline) | components/computer/desktop-screen.tsx, use-desktop-input.ts, desktop-input.ts |
| F-15 | Inbox | Layout is a stack: title form, thread list, then the thread and composer. On a thread with history the "Message" box is 7400px down the page (docH 7622). No sticky composer, no scroll to latest. Title and message inputs are 358px wide and OK. | major | inbox-thread-below-list-composer-7400px-down.png, inbox-composer-at-page-bottom.png | routes/_app/inbox.tsx, components/inbox/thread-panel.tsx, post-composer.tsx, post-list.tsx |
| F-16 | Every table page | Tables keep desktop width inside an `overflow-x-auto` wrapper, with the Actions column last. Table widths vs 358px: Log 1006 (Summary and Links off-screen), Routines 1130 (Schedule, Status, Pause/Remove off-screen), Triggers 438, API keys 640, Secrets 783, Machines 610, Connectors 836, Library 475 (rename/move/delete off-screen). Users must find the sideways scroll to reach actions, with no scroll hint. Row action buttons are 28px with about 4px gaps. | major | log-table-wide-horizontal-scroll.png, log-table-scrolled-right.png, routines-table-hscroll-actions-offscreen.png, triggers-table-hscroll-actions-offscreen.png, library-table-actions-offscreen.png, library-row-actions-after-hscroll-small-targets.png | wrapper is ui/table.tsx (do not edit). Callers: log/log-table.tsx, routines/routine-table.tsx, triggers/trigger-table.tsx, secrets/secrets-table.tsx, routes/_app/settings.api-keys.tsx, routes/_app/settings.machines.tsx + machines/machine-row.tsx, routes/_app/settings.connectors.tsx, library/library-list.tsx |
| F-17 | Library file view | Tapping a file opens the editor panel below the whole file table (and wiki card, forms) with no scroll or change in view, so nothing appears to happen. File names and rows are 28-32px. | major | library-file-select-panel-below-fold-no-feedback.png | routes/_app/library.tsx, library/library-file-panel.tsx, library-list.tsx |
| F-18 | Map (read and editor) | The whole graph is fitted into a 358x~440 canvas, so nodes are about 60x23px with unreadable 4-5px text and tiny handles. Pinch zoom is possible in React Flow, but there is no larger view or list alternative. | major | map-editor-canvas-tiny-palette-drag-only.png | components/map/map-canvas.tsx, map-nodes.tsx, map-page.tsx |
| F-19 | Map editor, tool palette | Dropping a tool, skill or computer onto an agent uses HTML5 drag and drop only (`draggable` + `dataTransfer`), which does not fire on touch. There is no tap alternative, so plugging a tool into an agent from the map cannot be done on a phone (the same can be done in the agent profile sheets). | blocker | map-editor-canvas-tiny-palette-drag-only.png | components/map/tool-palette.tsx, map-canvas.tsx, map-page.tsx |
| F-20 | Map inspector | Tapping a node selects it, but the inspector renders at the bottom of a 3072px page, so the user sees only a green border. Drawing a wire needs a drag from a tiny handle. "Delete wire" buttons and node "Remove" buttons are tiny canvas controls. | major | map-node-tap-no-visible-inspector.png, map-inspector-below-fold-after-node-tap.png | components/map/map-inspector-pane.tsx, map-inspector.tsx, map-page.tsx |
| F-21 | Skills index | Three forms (new skill, upload, GitHub import) take about 880px before the skills list starts. Skill rows are 28px. | minor | skills-index-forms-push-list-down.png | components/skills/skills-list.tsx, skill-new-form.tsx, import-github-form.tsx, routes/_app/skills.index.tsx |
| F-22 | Create routine dialog | The dialog is 725px tall with no max height or scroll. On a 664px visible viewport the title and Close X are above the screen (top -30px) and the Create routine button is cut at the bottom, and page scroll does not move the modal. With the keyboard open it cannot be submitted. At 360x740 it just fits. | blocker | create-routine-dialog-taller-than-screen.png, create-routine-dialog-360x740-cut-off.png | components/routines/create-routine-dialog.tsx (uses plain `DialogContent`; needs `max-h-[calc(100dvh-2rem)] overflow-y-auto` from the caller) |
| F-23 | Whole app | Touch targets under 40px nearly everywhere: header theme toggle 70x28 and avatar 28x28, menu 28x28, dialog Close X 28x28 (icon 16px), default buttons 32px, `sm` buttons 28px, chips 22px, text links 16-20px (breadcrumbs, "from task", agent links), file tree and nav rows 28-32px, switches 32x18. No hover-only controls were found. | minor (cumulative) | desk-360x740.png, skill-detail-tabs-tree-small-targets.png | ui/button.tsx sizes and ui/dialog.tsx Close (CLI output, set sizes at callers) |
| F-24 | Routines, Triggers, API keys | "Remove" (routine, trigger) and "Revoke" (API key) act immediately with no confirm, as 28px buttons next to Pause/Resume. Easy to hit by accident on touch (this caused the Incident above). | major | api-keys-revoke-no-confirm-small-target.png | routes/_app/settings.api-keys.tsx (`revokeKey`), routes/_app/routines.tsx (`removeRoutine`), components/routines/routine-table.tsx, triggers/trigger-table.tsx |
| F-25 | Settings pages | The settings nav (3 group labels and 6 links, 330px) sits above the content of every settings page, so the actual content starts a third of the way down the screen. Also "Machines" heading wraps mid-word ("Machin / es") next to two header buttons. | minor | settings-nav-takes-top-third.png, settings-machines-heading-wraps-table-clipped.png | routes/_app/settings.tsx, components/settings/settings-nav.ts, routes/_app/settings.machines.tsx |
| F-26 | Settings machines | Machine rows pack roles, online badges and last seen into narrow columns and clip "Last seen" ("about 24 hours a..."). | minor | settings-machines-heading-wraps-table-clipped.png | components/machines/machine-row.tsx |

Checked and fine: no page-level sideways scroll at 390px on any route except agent profiles (F-04), Input and Textarea primitives are 16px, the other dialogs (Rename, Move, New page, New task, Ask, Create trigger, Create key, Add connector, Time limit, Replace value, Edit hosts, Edit rules, Add computer, Add folder) fit within 664px and keep Close visible, New secret and Edit rules scroll internally, and the Clerk user menu works.

## Cross-cutting patterns

1. Wide tables behind `ui/table.tsx` (F-16, F-09, F-11, F-26). One responsive approach, such as a stacked card row on small screens or a pinned Actions column, applied in the 9 caller components clears the biggest group.
2. Native select at 14px (F-07). One class fix in `ui/native-select.tsx` callers, or a global `text-base md:text-sm` override, stops iOS zoom in 9 places. The same applies to the composer and skill textareas, which use their own `text-sm`.
3. Dialogs and sheets with no height cap or small width. `ui/dialog.tsx` has no max-height or scroll (F-22 is the one that breaks), and `ui/sheet.tsx` defaults to 75% width (F-09, F-08). Fix at the callers by passing `max-h` + `overflow-y-auto` and `w-full` on mobile.
4. Detail panels render below long lists with no scroll-into-view (F-17 library, F-20 map inspector, F-15 inbox composer, F-13 task composer). A "scroll to panel on select" or a sticky composer helps all four.
5. Mobile nav sheet does not close on navigate (F-01), the single highest-traffic problem.
6. Touch-size defaults (F-23): the `sm` button (28px), 22px chips, 16px checkboxes and 18px switches repeat across all screens.
7. Mouse-only interactions: HTML5 drag and drop in the map palette (F-19), pointer, wheel and right click only in the computer takeover (F-14), and no confirm on one-tap destructive actions (F-24).

## Not reached, and why

- Approval and question cards in the chat thread (`requests/request-card.tsx`): no task was waiting on a request, and creating one means sending a run to an agent, which was out of bounds.
- Computer takeover with a live screen: the only computer (`morosini`) is offline.
- Wiki page view, wiki history and the library history panel: the wiki has no pages, and creating one cannot be undone (no delete allowed). Library Delete and Upload (native file picker) were not run. File attachment from the device was not run for the same reason.
- Connector dialogs for OAuth client, paste credential and allowed tools: the only connector (`c-smoke-stub`) has auth "none".
- Machine enrol code output and revoke dialog: creating a code changes state, revoke is destructive.
- Profile Run now, Archive agent confirm, Agent new "Draft" (model call), skill Approve/Reject, trigger secret dialog, delete dialogs: all change state or send.
- On-screen keyboard behaviour (viewport resize, input hidden behind keyboard) and real touch gestures (pinch zoom on the map, long press): not emulated by the tool.
- Login, sign-up, choose-organization: Clerk hosted UI, not part of the app's own layout.
