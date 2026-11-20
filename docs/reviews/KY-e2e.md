# KY end-to-end walkthrough

Task KY.7. Verdict: the Keys flow works on local at 1280x800 and 390x844 up to the point where an agent calls a tool. Admin, member, catalogue, Keys tab and "Your sign-ins" all pass. The last step, "the agent uses the tool in a task with the fake runtime", cannot be walked, because the fake runtime never calls a tool. The tool path was proven by hand instead. So the task's check, "the walkthrough passes on local", is met for every step but that one, and `browser.md` records the verdict as FAIL for that reason. KY.9 below is what lets it pass. Four small defects were fixed on the branch. Five things are proposed as tasks below.

The browser proof, step by step with screenshots, is `docs/reviews/tasks/KY.7/browser.md`. A fresh verifier ran it.

## What was real and what was not

- The run used the fake runtime and the agent "Fake echo" from `bun scripts/dev/seed-fake-agent.ts`. It answers "Echo: <input>" and finishes inside dispatch. It never calls a connector tool.
- The admin signed in through dev login. The member was the existing plain member `dev+member@harbouredgeintelligence.ai`, signed in with `bun run agent-login`. No Clerk user was created.
- Vendor OAuth was followed only to the vendor's page: Gmail reached Google (a redirect_uri_mismatch for localhost, expected), Linear reached `mcp.linear.app/authorize`, Notion reached `app.notion.com/login`. Nothing was connected for those apps.
- A real connection was made on a header connector pointed at the public Cloudflare docs MCP server, because local addresses are blocked. The member pasted a value, saw "You are signed in.", and disconnected from "Your sign-ins".
- The tool path was walked by hand with curl against `POST /api/proxy/<connectorId>`, using run tokens the verifier minted for the two finished runs (set back to running in local D1 for the call, then restored).

## Result by step

| Step | Result |
|---|---|
| Settings pages open for the admin | Apps, Passwords and keys and Your sign-ins open. Apps has no catalogue (KY.12 below). |
| Admin adds from the catalogue on the Keys tab | Gmail 5 tools, Linear 4, Notion 2, Cloudflare Docs 1, taken from the catalogue entry. Change sign-in mode, allowed tools, remove and re-add work. |
| Member on the Keys tab | Catalogue add is admin only (Notion and Slack disabled). The member gets no "Connect as this agent" or "Paste as this agent" (KY.8 holds). "Connect my account" reaches the vendor. A header app connects and shows "You are signed in." |
| Your sign-ins | Opens from the user menu and from Find. Connect, Replace and Disconnect work. |
| Task with the fake runtime | Admin and member each started a task, both ended Done with "Echo: ...". The run records the person who pressed the button. |
| Tool call, by hand | The member's run with the member's sign-in got real docs text. The admin's run, with no sign-in, was refused with a connect link and no one else's sign-in was used. The catalogue allow-list cut `tools/list` to one tool and a tool outside it got 403 `tool_not_allowed`. |

Not exercised: "Its own" mode with an agent credential, a refresh of an expired sign-in, and a real MCP client discovering the proxy.

Console and network: no error or failed request on any page at either size apart from three things. One 500 on `/home` right after dev login (`SQLITE_BUSY` in the dev log) at the moment the verifier's seed script wrote the same file, not seen again. The phone overflow below. Errors from Notion's and Google's own pages during the vendor visits.

## Fixed on this branch

- Copy that still named the old tabs. Settings, Apps said "the agent's Connectors tab", Settings, Passwords and keys and its empty state said "Secrets tab". All three now say "Keys tab".
- "Your sign-ins" told a member "An admin has to set this app up first." for Linear and Notion, with no Connect, although the Keys tab connects them. An OAuth app nobody has connected yet has no OAuth settings on record, and Connect finds them itself. `sign-in-logic.ts` now offers Connect in that case and keeps the admin note for a server that cannot register a client. Test changed to match.
- The Keys tab row showed "Connect my account" for an app set to "Its own" sign-in, which never uses the person's. It is hidden in that mode.
- The Keys tab row showed the whose-sign-in select for an app that needs no sign-in. It is hidden for those apps.
- Each has a component test. A second fresh verifier then checked all four in the browser at both sizes and re-walked the flow on the final code (Round 2 in `browser.md`). It found them working. Its verdict is still FAIL, for the tool-call step and the phone overflow below only.

## Proposed tasks

### KY.9 A fake runtime that calls a connector tool

Finding. The walkthrough's last step has no way to run. The fake runtime echoes. The proxy accepts a call only with a run token for a running run, so a person cannot see an agent use a tool without hand-minting tokens.

Scope. A second fake mode, chosen by the task text or the agent's model name (for example `fake-tool`), that after claiming the run reads the agent's assigned connectors, calls `tools/list` and one allowed `tools/call` through its own `/api/proxy` path with a real run token, and writes the result as run events and as the reply ("Used search_cloudflare_documentation: ..."). If the tool needs a sign-in the person asking lacks, the reply carries the connect link from the proxy error. The mode is registered only when `devFakeRuntime` is true, as the echo runtime is. It needs the proxy's base URL, so decide how `createRunsService` learns it (a new dep, not `env`).

Check. A `runs` test with a stubbed proxy fetch: a run with a signed-in person calls the tool, a run with none gets the connect link, a tool outside the allow-list is refused. Browser: add Cloudflare Docs to Fake echo, press Run now, read the tool result in the task.

### KY.10 What a plain member can do on the Keys tab

Finding. A plain member sees the whole Slack connect form for the agent's identity, the "Passwords and keys" panel with the workspace secret list and grant switch, Remove, Allowed tools and the sign-in mode select. Round 2 showed the server accepts a plain member changing the "Whose sign-in it uses" select. The rest were not pressed, so what else the server refuses is not known. KY.8 closed only the app credential.

Decision first. Who may change an agent's apps, tools, Slack app and secret grants: the owners and admins only (matching KY.8), or any member? If owners and admins, the tab disables the controls for everyone else, the secrets panel shows only to people allowed to see it, and the services refuse the rest.

Check. Service tests for owner, admin and member on assign, mode, allowed tools, remove, Slack app create and secret grant. Browser as the member: the controls are disabled or hidden.

### KY.11 Allowed tools for a catalogue app that has not been connected

Finding. A catalogue app has `defaultAllowedTools` but no cached tool list until someone connects. The Allowed tools dialog then offers only "Clear list", so the list cannot be narrowed, and Settings, Apps shows "Tools 0" while the Keys row says "1 tool".

Scope. Show the allowed names from the row in the dialog when the cache is empty, with remove per name, and show the catalogue's allowed count (or "not fetched yet") in the Apps table.

Check. Component tests for the dialog with an empty cache and the table row. Browser: add Gmail from the catalogue, open Allowed tools, remove one name.

### KY.12 The catalogue on Settings, Apps

Finding. Settings, Apps adds a connector only by URL. The catalogue is only on an agent's Keys tab, so an admin cannot add an app to the workspace without picking an agent. The KY milestone overview says "a small catalogue creates a connector from a name"; KY.4 built `catalog.add` and KY.5 put the picker on the Keys tab only.

Decision first. Either leave the catalogue on the Keys tab and say so on the Apps page, or add the same picker to Apps. If added, reuse `catalog.add` and the picker in `components/agent/room/keys/add-app.tsx` through a shared component.

Check. Browser as admin: add Linear from Settings, Apps, then see it in the Keys tab's "Already in this workspace" group.

### The task page is 424 px wide on a phone

Finding. `/threads/<id>` scrolls sideways at 390 px for admin and member. In the task layout the header's nav is `flex-nowrap`, and its right group (header actions, user button, theme toggle) is 224 px wide beside the logo and menu button, so the user button ends at 424. Other pages wrap the nav and fit. The cause is in `components/header.tsx` and `shell/header-menu-slot.tsx`, which RH.6 is rewriting on its own branch, so this is not fixed here.

Scope. Fold this into the RH.6 phone check if its branch has not fixed it already. After RH.6 merges, open `/threads/<id>` at 390 px. If it still overflows, let the right group shrink or hide the text actions in the task layout.

Check. Browser at 390x844 on a task page: `document.documentElement.scrollWidth` is 390 for admin and member.

## Nits left alone

- Settings, Apps shows no Connect for an OAuth connector with no stored OAuth settings yet, only "Set client", the same gap that was fixed on "Your sign-ins". Admins can connect from the Keys tab.
- On the Keys tab, a row set to "Its own" for an OAuth app with no way to register a client shows no control and no note, because the member's connect action is now hidden in that mode.
- The status badge can read "Ready" next to "You have not signed in yet." The badge describes the connector, not the person looking.
- The Keys tab has "Reconnect my account" but no Disconnect. Removing your own sign-in takes a trip to "Your sign-ins". This may be intended.
- Find: typing "sign-ins" ranks "Enrol a machine" above "Your sign-ins". "your sign" ranks it first. The hyphen is the cause.
- An unlabeled switch (accessible name "Browser") sits under "Apps it can use" with no visible label. It is the browser switch from the profile, not a KY component.
- The seeded Fake echo agent has no owner, so its home card reads "Owner" with nothing after it.

## Things to know about running this walkthrough

- agent-browser here shares one default Chrome profile, so cookies leak between sessions. Give every session its own `--profile` folder.
- A header connector saved with a value runs a real `tools/list` probe, so point it at a public MCP URL. `https://docs.mcp.cloudflare.com/mcp` works and accepts any header value.
- Run `bun scripts/dev/seed-fake-agent.ts` only while the dev server is idle, or it can race the server for the SQLite file (the `SQLITE_BUSY` above).

## Steps for Dom

- After deploy, connect one catalogue app on staging as a member from the Keys tab and from "Your sign-ins" (needs a real vendor account). Nothing past the vendor's sign-in page was seen here.
- Decide KY.10 (who may change an agent's apps) and KY.12 (where the catalogue lives).
