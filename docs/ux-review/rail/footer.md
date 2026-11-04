# Rail footer and Settings

Status: designed 5 Nov 2026 over four review rounds (Opus and Codex, both 8/10 on the final). Task RF.1. The clickable mockup is `footer-mockup.html` in this folder: open it with `?w=phone`, `?page=settings`, `?palette=1`, `?menu=1`, `?sheet=closed` and `?os=mac`. Where this file and the mockup disagree, this file wins. The review is at https://claude.ai/artifact/4JamTWv2EuCxq3Ww3FbqSF.

## Why

The footer had four text links (Agents, Apps, Files, Everything) and felt crowded. Settings could only be reached through Find.

## Dom's decisions (5 Nov 2026)

1. Members who are not org admins don't see Settings: no footer tab and no workspace menu item. The settings pages and their Find entries stay as they are.
2. Settings always opens Model providers on desktop.
3. On short desktop screens, Working collapses to the one-row summary.

## Footer

- Four equal tabs, icon (18px, lucide `Bot`, `LayoutGrid`, `Folder`, `Settings`) over a 13px weight-500 label: Agents (`/agents`), Apps (`/artifacts?kind=app`), Files (`/library`), Settings. At least 48px tall.
- The current tab gets the `sidebar-accent` fill, foreground text and a 2px cyan (`--df-electric-cyan`) top border, plus `aria-current="page"`. Agents is current on `/agents/*`, Apps on `/artifacts` with `kind=app`, Files on `/library/*`, Settings on every `/settings/*` route. No tab is current anywhere else, including while a queue item is open.
- A non-admin (decision 1, `isActiveAdmin` in `workspace-menu-logic.ts`) gets three tabs: Agents, Apps, Files.
- "Everything" is removed from the footer. Find stays in `findEntries`; add Settings itself only if the registry test needs it.
- Settings goes to `/settings/model-providers` on desktop and to the settings index on phones (below).

## Find

- Desktop: the header Find button shows the shortcut as a small `kbd`: `⌘K` on Mac, `Ctrl K` elsewhere. The rail has no Find button on desktop.
- Phones (the rail is a sheet, `useIsMobile`): a filled 44px button with a search icon and the label "Find", full width, between Working and the tabs. It opens the existing Find dialog and closes the sheet. No shortcut shown.
- Phones with the sheet closed: the top bar keeps a 40px search button that opens Find. The button that opens the sheet shows the Needs you count as a small orange badge, and its accessible name includes the count ("Open rail, 11 need you"). The avatar gets a 40px target.

## Working

- Working moves out of the scrolling area. It sits between the queue and the footer, shows at most three runs as links (rows at least 32px) and then "View all N running", linking to Every task filtered to running if that filter exists, otherwise to Every task.
- Phones, and desktop windows under 900px tall (decision 3): Working is one 40px row, "Working · N running ›". Tapping it expands the three runs in place.
- No Working block when nothing runs.

## Queue selection

The open item gets the accent fill, and its left status stripe turns cyan (3px). Keyboard focus is a separate 2px outline outside the card, so selection and focus look different.

## Settings

- Workspace menu: a plain "Settings" item after Invite people, for admins only (decision 1), going to the same place as the tab.
- Phones: the Settings tab opens `/settings`, a grouped index of the settings nav (the groups in `settings-nav.ts`) plus a "Workspace" group with Members (opens the existing members view). Each row is at least 44px with a chevron. On desktop `/settings` redirects to `/settings/model-providers`. Add `/settings` to the Find registry only if `find-registry.test.ts` demands it.
- The phone top bar shows "Settings" as its title on settings pages, if the top bar already shows titles; otherwise skip this.

## Out of scope

A light-theme redesign (check it renders legibly), new Find entries beyond the above, changing who may open settings pages on the server.
