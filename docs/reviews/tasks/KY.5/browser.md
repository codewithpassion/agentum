# KY.5 Keys tab: browser verification

Verdict: PASS. Every flow worked at 1280x800 and 390x844 as admin and as member, with no horizontal scroll and no console error or failed request from the Keys tab. The one failed request is `GET /favicon.ico` returning 404 on page load: the web app has no `public/` folder, so it is app-wide and was there before this task. The controller ruled it out of scope for KY.5, so the strict rule is met. Findings 1 to 3 below were fixed afterwards as copy-only changes (status words, and the whose-sign-in line hidden for apps with no sign-in or a workspace secret) with unit tests; the screenshots show the earlier wording.

Setup: commit 3bb37880, dev server on port 5191, Chrome driven with agent-browser (sessions `ky5-verify` admin, `ky5-member` member). The admin signed in through dev login. The local DB had no agent, so I inserted one ("Keys Verify") with SQL into the local D1. The member `dev+agentum-member@harbouredgeintelligence.ai` was made on the Clerk dev instance with role `org:member` in "Dev Workspace" and signed in with `agent-login --base-url http://localhost:5191` (the default base URL points at port 3000 and fails). The header connector was inserted into local D1. Saving a pasted credential runs a real tools/list probe, and local addresses are blocked, so the connector points at the public Cloudflare docs MCP server (`https://docs.mcp.cloudflare.com/mcp`). I also inserted a workspace secret and a secret-backed connector locally.

## Flow A: five sections (admin)
Desktop: opened `/agents/<id>?tab=keys`. Saw "Apps it can use", "Its own identity", "Passwords and keys", "Other agents" and the "Ask me before it..." card, plus the Slack, secrets, hands-to, subagents and connections panels. No horizontal scroll (scrollWidth 1280). Screenshots: desktop-1.png (top), desktop-8.png (full page).
Phone: same sections, scrollWidth 390 = clientWidth. phone-1.png (full page). Pass at both sizes.

## Flow B: add from catalogue (admin)
Desktop: "Add an app" is a native select with the group "From the catalogue" (Gmail, Linear, Notion, Slack, Cloudflare Docs), plus an "Add app" button. Added Cloudflare Docs. The row says "Uses the sign-in of the person asking, or its own.", "No sign-in needed." and "1 tool" (not "Every tool"). Added Gmail. The row says "You have not signed in yet.", "5 tools" and has "Connect my account" and "Connect as this agent" links. desktop-2.png. Clicking "Connect my account" (link to `/connect/<id>?as=user&return_to=...`) went to Google's sign-in OAuth page, which showed an error page saying redirect_uri_mismatch for localhost:5191 (expected for a local dev client). That is a vendor redirect, a pass. desktop-3.png.
Phone: Added Linear from the catalogue: "4 tools", "You have not signed in yet.". "Connect my account" went to `https://mcp.linear.app/authorize...` (title "Authorization Request"). phone-3.png. Pass.

## Flow C: change mode, allowed tools, remove (admin)
Desktop: select on Gmail "Its own" changed the sentence to "Uses its own sign-in. The agent has no sign-in yet." and back to "The person asking" gave "Uses the sign-in of the person asking. You have not signed in yet."; the count stayed "5 tools". The "Allowed tools" dialog on Gmail said the connector has no cached tool list, so tools cannot be picked; "Clear list" changed the row to "Every tool" and closed the dialog. After I seeded two cached tools on Cloudflare Docs, the dialog showed checkboxes, Filter, Select all, Clear and Save; ticking the second tool and Save changed "1 tool" to "2 tools". desktop-4.png. Remove opened an alert dialog "Remove Gmail from this agent? It can be added again later." with Cancel/Remove; Remove removed the row and Gmail came back in the add list. desktop-5.png.
Phone: select on Linear to "Its own" changed the sentence and kept "4 tools". Allowed tools on Header Test (live tool list), ticked one tool, Save: "Every tool" became "1 tool". phone-6.png. Removed all three rows through the confirmation. phone-2.png. Pass.

## Flow D: workspace header connector (admin)
Desktop: added "Header Test" from "Already in this workspace": "Every tool", "You have not signed in yet.", "Connect my account" and "Paste as this agent". The paste dialog opened ("Paste credential for Header Test", "Saved as yourself", Save disabled until text). desktop-6.png. The first two Save attempts failed in the dialog with "Could not read the tool list from that server" (405 from example.com, then the local stub blocked). Those cause the two 400 console lines; they come from my probe targets, not the tab. With the public MCP URL, Save worked: the control became "Reconnect my account" and the row said "You are signed in.". desktop-7.png.
Phone: reset the credential, added Header Test again, pasted and saved: "Reconnect my account", "You are signed in.". phone-4.png (dialog), phone-5.png (result). Pass.
Extra: a connector on a workspace secret shows "Key from secret VERIFY_KEY" with "Every tool" and no "sign-in missing" text (desktop-8.png).

## Flow E: member (non-admin)
Desktop: the catalogue group lists Notion (admin only) and Slack (admin only), both disabled. "Secret App (admin only)" is also disabled; Cloudflare Docs and Gmail are enabled in "Already in this workspace". The page shows Header Test (assigned by the admin) with "You have not signed in yet.". The member pasted a value, saved, and saw "Reconnect my account" and "You are signed in." desktop-9.png (overview), desktop-10.png (dialog), desktop-11.png (result). The member cannot add from the catalogue because those options are disabled; I did not try to bypass the select.
Phone: no horizontal scroll (390). Credential reset, pasted again: "You are signed in.". The member added Cloudflare Docs from the workspace group: row appears with "No sign-in needed." and "1 tool". phone-7.png (full page), phone-8.png, phone-9.png. Pass.

## Flow F: other sections
Both users, both sizes: the secrets panel (table with the granted toggle, host and status columns and notes), Slack panel (manifest steps, name, token, signing secret), hands-to, subagents switch, connections card and ask-before radios plus "Advanced" all rendered, with no errors. See desktop-8.png, phone-1.png, phone-7.png.

## Console and network
Console errors and failed requests per page: only the favicon 404 above (seen on first load for each session), plus the two 400s caused by my probe targets in flow D and a 404 seen once while visiting the Linear vendor page. A reload of the Keys tab afterwards logged no error and no failed request (resource timing shows none). Warnings only: Clerk development keys, WebGL fallback. Vendor redirects to Google and Linear were my clicks on Connect.

## Findings (not blockers)
1. Status badge shows the raw words "ok" and "needs_auth" next to the app name.
2. An app that needs no sign-in (Cloudflare Docs) still shows "Uses the sign-in of the person asking, or its own." and the whose-sign-in select. The "No sign-in needed." line is correct.
3. A secret-backed app also shows "Uses the sign-in of the person asking, or its own." above "Key from secret VERIFY_KEY".
4. "Connect my account" stays visible when the mode is "Its own" (Linear and Gmail).
5. A connector with no cached tool list gives an Allowed tools dialog with only "Clear list", so a catalogue app cannot be narrowed until its tools are fetched.
6. The member sees the "Passwords and keys" panel with the full workspace secret list and grant switch.
7. The floating TanStack devtools button covers the right edge of the last Remove button on desktop in some layouts (dev only).
8. The "Add an app" control is a native select with a button, not a menu; the groups and "(admin only)" labels match the spec.

Cleanup: dev server (PIDs 2838354, 2838356) and the stub server I started were stopped. No source file was edited and git was not touched. The local DB keeps my test rows (agent, connectors, secret).
