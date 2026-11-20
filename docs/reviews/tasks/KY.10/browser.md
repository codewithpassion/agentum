Verdict: PASS (flows 1, 2 and 3 at 1280x800 and 390x844; flow 4 not exercised, see below). Nothing in the app errored. The only console errors and non-2xx responses are the 400/403 replies to my own direct tRPC calls in flow 3.

# KY.10 browser verification

Branch task/KY.10-what-a-plain-member-can-do-on-the-keys-t at 13d0be2c. Dev server on port 5360, driven with agent-browser, one session and one `--profile` per person and size (admin-d, member-d, admin-p, member-p under tmp/KY.10/verify/prof). Admin signed in through "Dev login (local only)". Member is dev+member@harbouredgeintelligence.ai through `bun run agent-login --base-url http://localhost:5360`. No Clerk user added. Agent "Fake echo" (id 01M7VYS7MYYD8P9K7MPRX82VF4) came from `bun scripts/dev/seed-fake-agent.ts`: created by the seed script, no owner, so the member is neither owner nor creator. As admin I added two apps on the Keys tab: Cloudflare Docs (1 tool, no sign-in needed) and Gmail (5 tools, "Needs sign-in", has the sign-in select and "Connect my account").

Screenshots: desktop-1 admin Keys tab; desktop-2 member Keys tab; desktop-3 admin Keys tab after the member's refused calls (unchanged); desktop-4 member on /agents/new (flow 4). phone-1 admin Keys tab; phone-2 member Keys tab.

## Flow 1: admin (desktop-1, phone-1)
Steps: dev login, open /agents/<id>?tab=keys, add Cloudflare Docs and Gmail from the "App to add" select with "Add app", dump every control in the tab with its disabled state.
Seen, both sizes: "App to add" select enabled with Gmail, Linear, Notion, Slack, Cloudflare Docs; "Add app" disabled only while "Choose an app" is selected, enabled after picking one (the adds worked). Each app row has "Allowed tools" and "Remove" enabled. Gmail has "Connect my account" and "Connect as this agent", and "Whose sign-in it uses" enabled with the three options. Slack section shows the app-name field, Download/Copy manifest, Bot token and Signing secret fields, and "Connect Slack" (disabled only because the fields are empty, I did not submit). The "Passwords and keys" section is present with its "Open Passwords and keys" link. Scroll width equals viewport (1280, 390).
Result: PASS desktop and phone.

## Flow 2: member, not owner (desktop-2, phone-2)
Steps: agent-login as the member into the same URL, dump controls, screenshot, click disabled controls.
Seen, both sizes: "App to add" select and "Add app" disabled, with the line "Only the agent's owners and admins can change its apps." under the picker. On both app rows "Allowed tools" and "Remove" are disabled, and on Gmail "Whose sign-in it uses" is disabled. Under Slack the only text is "No Slack app yet." and "Only the agent's owners and admins can set up its Slack app."; no app-name/token/secret fields and no "Connect Slack". No "Passwords and keys" section and no link to it. "Connect my account" on Gmail is a live link, no "Connect as this agent". Clicking the disabled "Allowed tools" and "Add app" (and a forced click on Remove, phone) timed out as not interactable, no dialog opened, the page did not change. No horizontal scroll (1280, 390).
Observation, not a defect of this task: the "Subagents" switch is also disabled for the member, and the "Browser" switch is not. "Browser" was not in the task's list, I did not test whether the server lets the member flip it.
Result: PASS desktop and phone.

## Flow 3: server refusal as the member
Method: from the member's page, `fetch("/api/trpc/<proc>", POST, JSON body)` (the app's client is httpBatchLink at /api/trpc with no transformer and no CSRF header). Ids came from `connectors.assignments` (a 200 for the member).
Seen, desktop and phone (same results):
- connectors.assign with a credentialMode change on Gmail (`"agent"`): 403 FORBIDDEN "Not allowed: connectors.assign".
- connectors.assign with allowedTools ["get_message"] on Gmail: 403 FORBIDDEN, same message.
- connectors.unassign of Cloudflare Docs: 403 FORBIDDEN "Not allowed: connectors.unassign".
- secrets.setGrants with an empty list: 403 FORBIDDEN "Not allowed: secrets.write". (An empty list, no real secret existed, so this shows the call is refused before any lookup.)
My first assign used an invalid mode value and got a 400 schema error, which is my typo, not the app.
Afterwards the admin page (desktop-3, and the admin phone session) still shows both apps, "1 tool" and "5 tools", sign-in select still "user_or_agent".
Result: PASS.

## Flow 4: member creates own agent (best effort): not exercised
The member can open /agents/new and "Start blank", fill Name and "What it does", but "Create agent" stays disabled with "No runtime is available. Add a provider key or a machine in Settings." / "Pick where it runs." (desktop-4). The local workspace has no runtime for a member to pick, so no owned agent could be made through the UI. I did not write to the database to work around it. The owner-sees-enabled-controls case is therefore unverified in the browser.

## Console and network
- Admin desktop and admin phone: no console errors, no resource response >= 400.
- Member desktop and member phone: 5 console errors each, all from flow 3 (one 400 from my bad mode value, four 403 from the refusals). No resource-timing entry >= 400 from page loads, and nothing else errored. No favicon noise seen.
- Dev server log not scanned beyond startup; migrations through 0059 applied.

## Cleanup
Browser sessions closed and only the dev server PIDs I started were stopped.
