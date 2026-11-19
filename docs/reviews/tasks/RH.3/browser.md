# RH.3 browser verification

Commit f8bbb317, dev server `vite dev --port 5183` from `apps/web`, signed in through the dev login, agent-browser session `rh3-verify`, desktop 1280x800 and phone 390x844. Local D1 only. The workspace "Dev Workspace" started with zero agents; I inserted agents and one wiki suggestion with `wrangler d1 execute DB --local`.

Two limits to know. First, `agent-browser network route` did not intercept the page's fetches in this setup (routes registered, real response still came back, tried two glob patterns), so the mock in flow 4 is a `window.fetch` override installed with `eval` that answers `roster.list` only. Second, the avatar glyph "?" and the empty owner are an artifact of how the data was made, not of the page: rows inserted by SQL get the column default avatar, and the stub `roster.list` returns `ownerName: ""` and `costThisWeekCents: 0`, so a real card shows "Owner" with no name and "$0 this week" until RH.2 merges.

## 1. Landing (pass, both sizes)
Steps: signed in via "Dev login (local only)" on /login, then opened `http://localhost:5183/` directly. Saw: the URL became `/home`, not `/desk`. The page has an h1 "Home" and the wall (empty at this point, flow 2). The dev login redirect also lands on /home. Screenshots: `desktop-1.png`, `phone-1.png`.

## 2. Empty state (pass, both sizes)
Steps: with no agents, read /home. Saw: text "No agents yet. Describe your first job and an agent will do it." and two dashed cards, "New agent" and "Start from a template", both `href="/agents/new"` (computed border-style dashed), no Needs you strip. Screenshots: `desktop-2.png`, `phone-2.png` (same page state as flow 1).

## 3. Cards (pass, both sizes)
Steps: inserted three active agents (Alma Lead Research, Mo Weekly Report, Zed Inbox Triage), reloaded /home. Saw per card: avatar square, name, grey job line (first line of the soul), a state dot with a sr-only label ("Idle"), a status line ("Idle"), "Owner" and "$0 this week". Clicking the first card went to `/agents/01AGENTBBBBBBBBBBBBBBBBBBB` at both sizes. The real `roster.list` response is all `idle`, as expected from the stub. Screenshots: `desktop-3.png`, `phone-3.png`.

## 4. Sort order (pass with mock, both sizes)
This flow used a mocked response. RH.2 is not merged, so the real service returns every agent as idle. I added a fourth real agent (Bea Invoice Filing), then replaced `window.fetch` so `roster.list` returned the four real agent ids in a scrambled order: Alma=idle, Bea=working, Zed=stopped, Mo=needs_you (with owners, costs and status lines filled in). The envelope is plain tRPC `[{"result":{"data":[...]}}]` (no superjson wrapper). The mock only takes effect on the 10 second poll, since the first paint comes from the SSR loader. After the poll the wall read, in order: Mo (Needs you, amber dot and left bar), Zed (Stopped, red), Bea (Working, green), Alma (Idle, grey). Costs rendered as $0.99, $0, $2.50, $12.34. Screenshots: `desktop-4.png`, `phone-4.png`. Real all-idle response: see flow 3 and the logged response above.

## 5. Needs you chips (pass, real data, both sizes)
No mock. I inserted a pending `wiki_suggestions` row for Mo Weekly Report. `desk.rail` then listed it and /home showed a "Needs you" strip with one chip, "wiki/weekly-report.md" with href `/desk?item=01WIKISUGGESTIONAAAAAAAAAA`. Clicking it opened `/desk?item=01WIKISUGGESTIONAAAAAAAAAA` and the item pane showed the title, "Mo Weekly Report", "How it got here". The pane body says "Suggestion bytes not found" because my seeded row has no stored blob, which is my seed data and not the feature. With no open items (flows 1 to 4) the strip did not render. Note: the rail's "Add your AI account" setup step is not an item and gives no chip, as designed. Screenshots: `desktop-5.png`, `phone-5.png` (wall with chip), `desktop-5b.png`, `phone-5b.png` (pane after click).

## 6. Dashed cards (pass, both sizes)
"New agent" and "Start from a template" were clicked on /home at each size and both ended at `/agents/new`. Screenshots: `desktop-6.png`, `phone-6.png` (the /agents/new page reached).

## 7. Phone layout (pass)
At 390 wide the wall is one column: every card spans x=16 to x=374 (chip x=16 to 180), `documentElement.scrollWidth` = 390 = `innerWidth`, no horizontal scroll, no overflow. Screenshots: `phone-3.png`, `phone-4.png`, `phone-5.png`. At 1280 the wall is three columns.

## 8. Refresh (pass, both sizes)
With /home open, I renamed an agent in D1 (`update agents set name=...`) and did not reload. The card showed the new name 6 seconds later at desktop and 6 seconds later at phone, within the 10 second poll. Screenshots: `desktop-8.png`, `phone-8.png`.

## Console and network
/home at both sizes, 25 seconds each (covers two polls): no console errors, no 4xx or 5xx resources. Console only shows vite debug lines, the React DevTools info line and Clerk's "loaded with development keys" warning (third party, expected on a dev instance). `roster.list` and `desk.rail` polled repeatedly with 200s. The only console errors seen were two "Failed to load resource: 404" on `/desk?item=01WIKISUGGESTIONAAAAAAAAAA`, caused by my seeded wiki suggestion having no blob; they do not occur on /home, /agents/new or /agents/<id>. The vite log has one TanStack warning about no `notFoundComponent` configured on the root route, seen once, not tied to a flow I could pin down (likely a probe for a missing static file); it predates this task's files.

## Verdict
Pass. Flows 1 to 8 work at both sizes. Flow 4 passed through a mock (fetch override on `roster.list`) because RH.2 is not merged. Flow 5 used real data. No bug found in RH.3. Caveats for the developer: until RH.2, cards show an empty owner label ("Owner" followed by nothing).
