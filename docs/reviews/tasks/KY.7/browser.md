Verdict: FAIL on the final code (HEAD 991dc7d5), for two reasons only: (1) step 5, the agent using a tool in a task, cannot be walked because the fake runtime only echoes; (2) the phone task page `/threads/<id>` still scrolls sideways (424 against 390, admin and member). Every other flow in items a to d works at 1280x800 and 390x844 with no console error and no failed request from Agentum. Details in "Round 2" at the end.

Round 1: FAIL

# KY.7 Keys walkthrough: browser verification

Branch `task/KY.7-keys-e2e` (worktree HEAD 06de983a), dev server on port 5231, Chrome driven with agent-browser at 1280x800 and 390x844. Reasons for FAIL, in order of weight:

1. Step 5 cannot be fully exercised. The fake runtime only echoes, so no run ever called a connector tool. I could only prove the tool path by minting a run token by hand and calling the proxy with curl (see Step 5). The agent using the tool in a task was not seen.
2. Phone: the task page `/threads/<id>` scrolls sideways (scrollWidth 424 against 390) for both admin and member. The avatar and Dark toggle in the header are pushed off the right edge.
3. One console 500 on the admin desktop `/home` right after dev login (SQLITE_BUSY in the dev log). It coincided with my seed script writing the same SQLite file, and I did not see it again. I list it rather than ignore it.
4. Settings, Apps has no catalogue (add by URL only), so Step 1's "add an app from the catalogue there" cannot be done on that page. The catalogue is only on the agent's Keys tab.

Everything else in the flow worked at both sizes: catalogue add, allowed-tools count, change sign-in mode, remove and re-add, member visibility rules, member connect and disconnect, "Your sign-ins" from the user menu and Find, and a fake-runtime task started from the UI by both people.

## Setup

- Dev server: `bunx wrangler d1 migrations apply DB --local && bunx vite dev --port 5231` from `apps/web` (PID 3725181 is the `bunx` wrapper, 3730189 the `vite dev` node child). Migrations applied through 0057. The local D1 was empty (fresh workspace, no agent).
- agent-browser here is configured with one shared default Chrome profile (`~/.agent-browser/config.json`). My first session came up already signed in as the dev user from a cookie that was not mine, so I closed it and gave every session its own `--profile` folder under `tmp/KY.7/profiles/` (admin-desktop, member-desktop, admin-phone, member-phone). Admin signed in through the "Dev login (local only)" link on `/login` in a clean profile. The known 400 after dev login did not appear in the console this time.
- Member: `dev+member@harbouredgeintelligence.ai` through `bun run agent-login --base-url http://localhost:5231`, opened in a fresh profile. It landed on `/home` in "Dev Workspace" with no choose-organization or pending screen. No Clerk user was created. The member's rail has no Settings tab.
- Seed: `bun scripts/dev/seed-fake-agent.ts` created "Fake echo" (id 01M7VK1W9S49JZMFDYG7GJP5KN). It has no owner, so its home card reads "Owner" with no name (seed artifact, ignored).
- Header connector: made through the UI (Settings, Apps, Add connector: name "Docs Header", URL `https://docs.mcp.cloudflare.com/mcp`, API key header `Authorization`). The probe worked and cached 2 tools.
- Direct local D1 edits (setup only): the seed script above, and for Step 5 one `sqlite3` update setting the two completed runs back to `running` with a lease 2 hours ahead, reverted to `done` afterwards. I also wrote `tmp/KY.7/mint.ts`, which signs run tokens with `RUN_TOKEN_KEY` from `apps/web/.env.local`. The key and tokens were never printed or put here. No remote D1, secrets or deploys were touched, no source file was edited.
- Console and network: read with `agent-browser console` and `performance.getEntriesByType("resource")` (status >= 400) per session, plus the dev log.

## Step 1: Settings, Apps, Passwords and keys, Your sign-ins (admin)

Desktop (desktop-1, desktop-2): `/settings/connectors` shows the heading "Apps" and "No connectors yet. Add one by URL." with one button, "Add connector". The dialog has Name, URL, Authentication (Automatic, OAuth, API key header, None) and Header name. No catalogue anywhere on the page, so nothing was added from the catalogue here (finding 1). After catalogue adds on the Keys tab the page lists them as connectors. `/settings/secrets` ("Passwords and keys") and `/settings/sign-ins` ("Your sign-ins") both open for the admin. Sign-ins is empty at first: "No apps yet. An admin adds them under Settings, Apps." No horizontal scroll (1280 = 1280).
Phone (phone-1, phone-2): same pages open, connectors render as stacked cards, scrollWidth 390. The sign-ins page later lists all four apps.
Result: desktop PASS with finding 1, phone PASS.

## Step 2: Keys tab as admin

Desktop: `/agents/<id>?tab=keys`. The "App to add" select has the group "From the catalogue" (Gmail, Linear, Notion, Slack, Cloudflare Docs). I added Cloudflare Docs: "Ready", "No sign-in needed.", "1 tool". Added Gmail: "Needs sign-in", "Uses the sign-in of the person asking, or its own.", "You have not signed in yet.", "5 tools", with "Connect my account" and "Connect as this agent" (desktop-3). The local table `agent_connectors` confirms the counts come from the catalogue entry's `defaultAllowedTools` (Gmail 5 names, Linear 4, Notion 2, Cloudflare Docs `["search_cloudflare_documentation"]`); the header connector has no catalogue key and shows "Every tool".
- Sign-in mode on Gmail: "Its own" gave "Uses its own sign-in. The agent has no sign-in yet."; "The person asking" gave "Uses the sign-in of the person asking." and dropped "Connect as this agent"; back to "The person asking, or its own" restored it. The count stayed "5 tools". "Connect my account" stays visible in "Its own" mode (finding 6).
- Allowed tools on Gmail: the dialog says the connector has no cached tool list, so tools cannot be picked, and offers only "Clear list" (finding 8). On Docs Header (live list, phone) I ticked one tool and Save changed "Every tool" to "1 tool".
- Remove: "Remove app? Remove Gmail from this agent? It can be added again later." with Cancel and Remove (desktop-4). Remove removed the row; the select then listed Gmail under "Already in this workspace". Re-adding it from there gave "5 tools" again.
- Added Linear and Docs Header too. Full page: desktop-5. After the member signed in, the admin's Docs Header row also shows "Other people: Member Tester: signed in".
Phone: removed all four rows through the confirmation, added Notion from the catalogue ("2 tools", phone-4), then Cloudflare Docs, Docs Header and Linear from the workspace group. Allowed tools dialog (phone-5) lists both tools with Filter, Select all and Clear. Mode change on Linear to "Its own" and back worked. The page is 390 wide (phone-3, phone-6).
Result: desktop PASS, phone PASS.

## Step 3: Keys tab as member (plain org:member)

Desktop (desktop-6): the assigned apps show. The "Add an app" select disables "Notion (admin only)" and "Slack (admin only)". Rows show "Connect my account" but no "Connect as this agent" or "Paste as this agent", so the KY.8 hiding works for app credentials. The member still sees Remove, Allowed tools, the sign-in mode select, the whole Slack connect form and the "Passwords and keys" panel (finding 9).
- Gmail "Connect my account" went to `accounts.google.com/signin/oauth/error` (redirect_uri_mismatch for localhost, expected), desktop-7. Linear went to `mcp.linear.app/authorize` ("Agentum is requesting access"). Stopped at both. On phone Notion went to `app.notion.com/login` (mcp.notion.com redirect), phone-9. Stopped.
- Docs Header "Connect my account" opens "Paste credential for Docs Header" ("Saved as yourself. Paste the whole Authorization header value"). Saving a test value ran the real probe against the public Cloudflare docs server and worked: "Ready", "You are signed in.", button changed to "Reconnect my account" (desktop-8, phone-10). The Keys tab has no Disconnect, only Reconnect (finding 10). The disconnect path is on "Your sign-ins".
Phone: same rows (phone-8), no horizontal scroll (390), pasted again and saved: "You are signed in."
Result: desktop PASS, phone PASS.

## Step 4: Your sign-ins as member

Desktop: user menu has "Your sign-ins", which opens `/settings/sign-ins` (desktop-9). Rows: Cloudflare Docs "No sign-in needed", Gmail "Not signed in" with Connect, Linear "Not signed in", Docs Header "Signed in" with Replace and Disconnect. Disconnect worked at once ("Disconnected from Docs Header.", row back to "Not signed in" with Add sign-in), and Add sign-in with a new value gave "Signed in" again. Gmail "Connect" reached accounts.google.com. Find: "your sign" lists Settings, "Your sign-ins" ("Your logins") and opens the page (desktop-10). Typing "sign-ins" lists "Enrol a machine" first, and Enter opened `/settings/machines` (finding 11).
Linear and Notion read "Not signed in. An admin has to set this app up first." with no Connect, although the Keys tab connected Linear fine. After that first Connect on the Keys tab, the same page shows Linear with Connect (finding 3).
Phone: user menu and Find (phone-11) both reach the page (phone-7 shows it); Disconnect worked; scrollWidth 390.
Result: desktop PASS, phone PASS, with finding 3.

## Step 5: the agent uses the tool in a task

What ran in the UI: on "Fake echo", Run now, with Cloudflare Docs, Docs Header, Gmail and Linear assigned. Admin desktop: "Done", "Echo: Use the Cloudflare docs tool to look up Workers limits", started by Dev User, "Fake runtime" (desktop-11). Member desktop: "Done", started by Member Tester, echo (desktop-12). Admin and member on phone: the same, "Done" with an echo (phone-12 shows the admin's). The member phone task page also scrolls sideways (finding 4). The local `runs` rows record `on_behalf_of_user_id` as the person who pressed the button.

What that proves: only that a run starts and finishes with the fake runtime, and that the run is tied to the person who started it. `packages/services/src/runs/fake-runtime.ts` replies "Echo: <input>" and never calls a connector tool. No run, in the UI or otherwise, was seen calling a tool.

What I could exercise by hand (desktop, curl against `POST /api/proxy/<connectorId>`, which is the route the real runtime points its MCP servers at through `connectors/mcp-servers.ts`): the proxy accepts a run token for a `running` run with a live lease. I minted two run tokens by hand for the two completed runs and set both back to `running` in local D1. Results:
1. Member's run, Docs Header (member's pasted sign-in), `tools/list` then `tools/call search_cloudflare_documentation` ("Workers CPU time limits"): HTTP 200 with real Cloudflare docs text (the upstream accepts any header value, so it does not prove the exact value was forwarded; the event log shows `ownerKind: "user"`).
2. Admin's run, same connector and call (admin has no sign-in there): HTTP 200 JSON-RPC error `needs_auth`: "This connector needs your login. Open .../connect/<id>?as=user while signed in to Agentum to connect it." Event `connector.needs_auth`, `ownerKind: user`, `ownerId` the admin. So with "the person asking, or its own", the person who started the run is the sign-in used, and a run with no sign-in for that person is refused with a link, not given someone else's.
3. Member's run, Cloudflare Docs (no sign-in), allowed tool: HTTP 200 with docs text. `tools/list` through it returns only `search_cloudflare_documentation`, so the catalogue allow-list cuts the live list (the upstream has two tools).
4. Same connector, tool `migrate_pages_to_workers_guide` (not in the list): HTTP 403 `{"error":"forbidden","reason":"tool_not_allowed"}`, event `outcome: denied`.
Not tested: "Its own" mode with an agent credential, a refresh of an expired sign-in, and a real MCP client (Claude Code) discovering the proxy. Missing: a fake runtime that calls a connector tool through the proxy on its own, so the whole path from task to tool can be walked without hand-minting tokens (finding 12).
Result: UI task run PASS at both sizes (but phone page overflows). "Agent uses the tool in a task": NOT exercised end to end, partly proven by hand. This step fails the walkthrough.

## Console and network

- Admin desktop: one `Failed to load resource: 500` on `/home` right after dev login. The dev log shows `tRPC desk.rail failed ... SQLITE_BUSY database is locked` once, at the time my seed script was writing the same file. Not seen again.
- All other pages at both sizes for admin and member: no console error and no response with status >= 400. The dev-login 400 and the favicon 404 did not show up in my checks, so I did not count them.
- Member phone: console errors listed during the Notion vendor visit (`app.notion.com` Splunk CORS, Google sign-in FedCM). They come from Notion's own page, not from Agentum.
- Warnings only elsewhere (Clerk development keys, WebGL fallback, "No available adapters").
- Horizontal scroll: none on Settings pages or the Keys tab at 390 (scrollWidth 390). Yes on `/threads/<id>` (424), see finding 4.

## Findings

1. Settings, Apps has no catalogue, only "Add connector" by URL, so an admin cannot browse the catalogue there. Seen: desktop-2. Both sizes. Larger (a decision on where the catalogue lives, plus a picker); small if the choice is to leave it on the Keys tab.
2. Stale copy. Apps page: "Paste a credential as an agent from the agent's Connectors tab." Passwords and keys page: "grant it on an agent's own page, in its Secrets tab." Both tabs are now Keys. Both sizes. Small.
3. "Your sign-ins" shows "An admin has to set this app up first." with no Connect for OAuth catalogue apps that have no registered client yet (Linear, Notion), while the Keys tab's "Connect my account" works for the same app and, after it runs once, the sign-ins page offers Connect. A member who starts at "Your sign-ins" is stuck on first use. Both sizes. Small to medium (logic: offer Connect when the client can be registered on the fly).
4. Phone: `/threads/<id>` (the task page) is 424 wide on a 390 screen. The header row (Assistant, Board, Find, New, Dark, avatar) does not wrap there, so the avatar and Dark toggle are pushed out of view. Admin and member. Outside KY but it is the page Step 5 ends on. Small (header layout on that route).
5. A row can read "Ready" next to "You have not signed in yet." (Docs Header after another person signed in, or after any successful call). The badge describes the connector, not the person looking. Both sizes. Small (copy or logic).
6. "Connect my account" stays on a row set to "Its own" (seen in KY.5 too). Desktop and phone. Small.
7. The "Whose sign-in it uses" select shows on an app that needs no sign-in (Cloudflare Docs), next to "No sign-in needed." Both sizes. Small.
8. Allowed tools on a catalogue app with no cached tool list (Gmail, Linear before a connection) only offers "Clear list", so it cannot be narrowed. Settings, Apps also shows "Tools 0" for those connectors while the Keys row shows "1 tool". Both sizes. Small to medium (fetch the list, or show the allowed names from the catalogue).
9. A plain member sees and can use more than the app-credential rule: the whole Slack connect form (agent identity), the "Passwords and keys" panel, Remove, Allowed tools and the sign-in mode select. I did not press them, so I do not know what the server refuses. Desktop. Needs a decision from Dom, then small to larger.
10. The Keys tab offers "Reconnect my account" but no Disconnect, so removing your own sign-in needs a trip to "Your sign-ins". Both sizes. Small, may be intended.
11. Find: "sign-ins" ranks "Enrol a machine" above "Your sign-ins", and Enter opens `/settings/machines`. "your sign" ranks it first. Desktop. Small (hyphen in the query).
12. No local way to see an agent use a tool: the fake runtime never calls one, and the proxy needs a run token for a `running` run. Larger, its own task (a fake runtime mode that calls one assigned connector tool through `/api/proxy`, so KY.7's last step can be a real browser walk).
13. An unlabeled switch (accessible name "Browser") sits under the "Apps it can use" heading with no visible label (desktop-3, phone-8). Both sizes. Small.
14. Setup notes, not product defects: agent-browser's default shared profile leaks cookies between sessions, and the passwords/probe step needs a public MCP URL. The seeded agent has no owner, so its card reads "Owner" with nothing after it.

Evidence: desktop-1 to desktop-12 and phone-1 to phone-12 in this folder.

## Cleanup

The dev server (PIDs above) was stopped by PID. Browser sessions were closed. The local D1 keeps the rows made here (agent, four connectors, assignments, the member's sign-in, four runs and their events).

## Round 2

Final code: HEAD 991dc7d5 on `task/KY.7-keys-e2e`. Dev server on port 5241 (`bunx` PID 4004462, `vite dev` PID 4004554, both stopped by PID at the end), log `tmp/KY.7/dev3.log`. Four fresh sessions with their own profiles (r2-admin-desktop, r2-member-desktop, r2-admin-phone, r2-member-phone). Admin signed in with "Dev login (local only)", the member with `agent-login` for `dev+member@harbouredgeintelligence.ai` in a fresh profile (no Clerk user created, URLs not kept here). Screenshots are desktop-13 to desktop-30 and phone-13 to phone-27.

Setup: the local D1 held round 1's data. I wrote no rows by SQL (only read-only selects). To get "an OAuth catalogue app that nobody has connected yet" I used the UI: removed Linear and Notion from Fake echo, deleted Gmail, Linear and Notion under Settings, Apps (Delete), and added Linear, Notion and Gmail again from "From the catalogue" on the Keys tab. The database then showed `oauth` null for all three until someone pressed Connect. On the phone I did the same for Notion (delete, re-add from the catalogue) so Notion was fresh again for the phone member. The local D1 now holds these new connector ids, four new runs and their events.

### a. Stale copy

Desktop: Settings, Apps footer reads "Paste a credential as an agent from the agent's Keys tab." (desktop-13). Passwords and keys reads "An agent gets a secret only when you grant it on the agent's own page, in its Keys tab." and the empty state "No secrets yet. Add one, then grant it on an agent's Keys tab." (desktop-14). Phone: same three strings (phone-13, phone-14). Result: desktop PASS, phone PASS.

### b. Your sign-ins, plain member, OAuth apps nobody connected

Desktop (desktop-20): Linear, Notion and Gmail, freshly added, each read "Not signed in" with a "Connect" button and no "An admin has to set this app up first." Connect on Linear went to `mcp.linear.app/authorize` ("Agentum is requesting access", desktop-21). Connect on Notion went to `app.notion.com/login` (desktop-22). Connect on Gmail went to `accounts.google.com/signin/oauth/error` (redirect_uri_mismatch for localhost, expected, desktop-23). I stopped at each vendor page. Phone: Notion was fresh again and showed Connect (phone-21), and Connect reached `app.notion.com/login` (phone-22). After a first Connect the connector keeps its OAuth settings, so Linear and Gmail showed Connect on the phone for that reason too; the fresh-app proof for them is the desktop run. Result: desktop PASS, phone PASS.

### c. Keys tab on Fake echo

Admin desktop: Linear set to "Its own" shows only "Connect as this agent" and no "Connect my account" (desktop-17); "The person asking" brings "Connect my account" back and drops "Connect as this agent" (desktop-18); "The person asking, or its own" shows both again. The header app (Docs Header) in "Its own" shows only "Paste as this agent" (desktop-19), "The person asking" shows "Connect my account", and "The person asking, or its own" shows both. Cloudflare Docs has no "Whose sign-in it uses" select, still reads "No sign-in needed.", and keeps Allowed tools and Remove (desktop-16).
Member desktop: Linear in "Its own" shows no "Connect my account" and no agent action (desktop-25); back to "The person asking" and to "The person asking, or its own" brings it back. Docs Header in "Its own" shows no connect action. A signed-in member sees "Reconnect my account" with no "Paste as this agent" (desktop-24).
Phone: admin Notion and Docs Header, member Notion, all the same (phone-15 to phone-18, phone-23); Cloudflare Docs has no select (phone-15, phone-17).
Result: desktop PASS (admin and member), phone PASS.

### d. Regress

Admin adds from the catalogue (desktop-16, phone-15): Gmail "5 tools", Linear "4 tools", Notion "2 tools", and the table confirms the counts come from the catalogue entries (`allowed_tools` lists of 5, 4 and 2 names). Cloudflare Docs shows 1 tool. Member header connector (public Cloudflare docs MCP server): sign-in removed on Your sign-ins ("Disconnected from Docs Header."), then "Connect my account" on the Keys tab, pasted a test value, saved, and the row reads "Ready" and "You are signed in." (desktop-26, phone-25). Your sign-ins opens from the user menu ("Your sign-ins") and from Find ("your sign", first result) for the member and the admin at both sizes (desktop-27, desktop-30, phone-20, phone-26). A fake-runtime task started with "Run now" on Fake echo ends "Done" with "Echo: ..." for the admin (desktop-29, phone-19) and for the member (desktop-28, phone-27). Each shows "Started by <person>" and "Fake runtime". Result: desktop PASS, phone PASS.

### e. Step 5 (the agent uses the tool in a task)

Still not exercisable in the browser. The fake runtime replies "Echo: <input>" and never calls a connector tool, so no task shows a tool call, a "needs your sign-in" prompt or the person's sign-in being used. What can be seen: a task starts, finishes "Done" with the echo, and records who started it. Round 1's curl proof through the proxy (run token, `needs_auth` for a person with no sign-in, `tool_not_allowed` for a tool off the list) is not repeated and was not re-run. The missing piece is the fake runtime mode proposed in `docs/reviews/KY-e2e.md` (finding 12 below). Result: FAIL at both sizes for this reason only.

### f. Phone task page overflow

`document.documentElement.scrollWidth` at 390: admin `/threads/<id>` 424, member `/threads/<id>` 424. It still overflows, as expected (known, proposed as a separate task). At 1280 the same pages measure 1280 for both. All other pages checked at 390 measure 390: Settings (Apps, Passwords and keys, Your sign-ins), the Keys tab, the vendor-free pages above. Result: phone FAIL (known).

### Console and network

Every Agentum page at both sizes for both people: no console error and no response with status >= 400 in `performance.getEntriesByType("resource")`. The dev log has no error, SQLITE_BUSY or 4xx/5xx line (181 lines). The earlier SQLITE_BUSY 500 did not return (no seed script ran). Errors only on vendor pages after leaving Agentum, not Agentum's: Linear/Google/Notion sign-in pages (a 403 resource, `GSI_LOGGER` FedCM, "Provider's accounts list is empty", `clientCookieHelpers`, and Notion's Splunk CORS block). The dev-login 400 and favicon 404 did not show up. Warnings only: Clerk development keys.

### New findings in round 2

1. Round 1 finding 9 is partly confirmed: the plain member changed the "Whose sign-in it uses" select on Fake echo (Linear and Docs Header) and the row updated at once, so the server accepted it. This is the agent-wide setting. Still needs Dom's decision. Not a defect of the four fixes.
2. Finding 5 still shows: Docs Header reads "Ready" next to "You have not signed in yet." on the admin's row while "Other people: Member Tester: signed in". Small, unchanged.
3. Finding 13 still shows: the unlabeled "Browser" switch under "Apps it can use". Small, unchanged.
4. Finding 12 stands: no way to watch an agent call a tool. The only blocker for step 5.
5. The working tree has an uncommitted change to `docs/reviews/KY-e2e.md` that I did not make (git status shows it as modified).
6. Setup note, not a product defect: agent-browser refs shift when a row loses a button after a mode change (for example "Connect my account" disappearing), so a select on an old ref can hit the wrong element or time out; take a fresh snapshot before each select.

### Cleanup

Dev server (PIDs 4004462 and 4004554) stopped by PID, port 5241 free. The four browser sessions are closed. No source file changed, no git action.
