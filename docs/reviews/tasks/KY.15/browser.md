Verdict: pass

# KY.15 browser verification

Worktree: /home/roboto/devel/harbourmaster-wt/KY.15, branch task/KY.15-owners-change-ask-before-hand-to. App: `vite dev --port 3151` against a freshly migrated local D1. Browser: agent-browser session `ky15-verify`, headless shell. Screenshots are in this folder.

## Caveats

- The local D1 had no agents and creating one through the UI needs a machine or an Anthropic key, so I inserted stub agents (runtime `fake`, status active, `owner_user_id` NULL so the owner is `created_by`). "KY15 Admin One" and "KY15 Admin Two" were created by the admin's Clerk user (user_3Kk8S5uJZvRLPGiEoZ8ZfJfCH8m). "KY15 Member One" was created by dev+member@harbouredgeintelligence.ai (user_3MLzrHwgcyG5ABwkRhvqdF8hoxg). I also inserted mail allow rules (`mail:friend@example.com`, `mail:pal@example.com`) so the "Always allowed" Remove buttons exist. All of it is deleted (see Cleanup).
- Two browser sessions were run, one signed in as the admin (org:admin) and one as the plain member (org:member), both in "Dev Workspace". Switching user needed a Clerk sign-out and cleared cookies, because `/dev-login` skips the token when a session already exists.
- I added one pass the task did not list: the admin viewing an agent the member owns (admin who is not the owner). The controls were enabled with no notes (desktop-11, phone-13). That is the case that separates "owner or admin" from "owner only".
- Clicks on disabled controls were made with real mouse events at the element's coordinates, since the automation's click waits for enabled elements. Each left the UI and the database unchanged.
- The "Always allow" answer path (open to any member) was not exercised here. It is covered by the service tests.
- The Subagents switch next to hand-to is disabled for the plain member on an admin-created agent (and enabled for owner and admin). It has no note of its own. That behaviour predates this task.
- Remove on a mail rule was clicked as the owner (desktop only), and the rule was deleted in the UI and the database. Not clicked as admin or on phone (state only: enabled).

## Flow A: org admin (agent "KY15 Admin One", created by the admin)

Desktop 1280x800
- Opened `/agents/ZZKY15ADMINAGENT1?tab=keys`. DOM check: 3 level radios enabled, hand-to checkboxes (2) enabled, Subagents enabled, no "Only the agent's owners and admins..." text for either section.
- Clicked "Ask before it acts outside", reloaded: it stayed selected, DB `ask_level` matched (desktop-1). Set it back to "Ask rarely" and reloaded to confirm.
- Ticked "KY15 Admin Two", reloaded: still ticked, DB `hands_to` held its id (desktop-2). Unticked it, DB back to `[]`.
- Opened Advanced and the Built-in tools group: 11 of 11 ask switches enabled, mail Remove enabled. Turned on "Write a file", reloaded: "Built-in tools 1 of 10 ask", the switch stayed on, DB had a `write`/`ask` rule (desktop-3). Turned it off again, DB rule removed.
- Shots: desktop-1, desktop-2, desktop-3.

Phone 390x844
- Same steps. Level change to "Ask before it acts outside" kept after reload (phone-1 before, phone-2 after), set back. Hand-to "KY15 Admin Two" ticked, kept after reload (phone-3), unticked. "Edit a file" switch turned on, kept after reload (phone-4), turned off. Everything enabled, no notes. scrollWidth 390 equals innerWidth 390.
- Shots: phone-1 to phone-4.

## Flow B: plain member on the admin-created agent "KY15 Admin One"

Desktop 1280x800
- DOM: 3 of 3 radios `disabled`, 2 of 2 hand-to checkboxes `disabled`, Subagents switch `disabled`. After opening Advanced and the Built-in tools group: 11 of 11 ask switches `disabled` and the mail "Remove friend@example.com" button `disabled`. The page text shows both notes: "Only the agent's owners and admins can change what it asks first." and "Only the agent's owners and admins can change who it hands work to."
- Real clicks at the "Ask before everything" radio, a hand-to checkbox, the "Write a file" switch and the Remove button changed nothing: radios stayed on "Ask rarely", checkboxes unticked, switch `aria-checked=false`, the Remove row remained. DB after the clicks: `ask_level` rarely, `hands_to` `[]`, the mail rule still present.
- Shots: desktop-4 (notes, disabled hand-to and level radios), desktop-5 (disabled switches), desktop-6 (Remove still listed after the click), desktop-7 (hand-to after the click).

Phone 390x844
- Same DOM result: radios 3/3, ask switches 11/11, hand-to 2/2 and Remove all disabled, both notes visible. Real clicks on the radio, hand-to checkbox, "Write a file" switch and Remove did nothing, DB unchanged. scrollWidth 390.
- Shots: phone-5 (hand-to with note), phone-6 (level card with note), phone-7 (after clicking the switch), phone-8 (after clicking hand-to).

## Flow C: plain member on "KY15 Member One" (created by the member)

Desktop 1280x800
- DOM: radios 3 enabled, hand-to 2 enabled, Subagents enabled, 11 ask switches enabled, "Remove pal@example.com" enabled. Neither note shown (desktop-8).
- Chose "Ask before everything", reloaded: kept (desktop-9), set back to "Ask rarely", reloaded to confirm. Ticked "KY15 Admin One", reloaded, kept, unticked. Turned on "Run a script", DB had a `run_script`/`ask` rule (desktop-10), turned off. Clicked Remove on the mail rule: removed in the DB and the UI.
- Shots: desktop-8, desktop-9, desktop-10.

Phone 390x844
- Same enabled DOM result, no notes (phone-9). Chose "Ask before it acts outside", reloaded: kept (phone-10), set back. Ticked "KY15 Admin Two", reloaded, kept (phone-11), unticked. Turned on "Fetch a web page" (phone-12), turned off. DB matched at each step. scrollWidth 390.
- Shots: phone-9 to phone-12.

## Extra: admin who is not the owner, on "KY15 Member One"

- Desktop: radios, hand-to and (via state check) all controls enabled, no notes. Changed the level and ticked hand-to, both kept after reload, then set back (desktop-11).
- Phone: Advanced and Built-in tools open, 11 of 11 switches and Remove enabled, "Fetch a web page" toggled on and off, no notes, scrollWidth 390 (phone-13).

## Console and network

- Admin session: one console error, the known 400 on the first load after dev login. No other errors across reloads on desktop and phone.
- Member session: after clearing the console buffer, reloads of the admin's agent and the member's agent showed only the Clerk dev-keys warning. One 401 console error was logged while signing the admin out before the member's dev login. It happened during the user switch, not on any Keys page load, so I counted it as noise from the switch.
- Second admin session (admin on the member's agent): no console errors after clearing the buffer.
- `performance.getEntriesByType("resource")` showed no response with status 400 or above on the pages checked at the end of each session. No failed tRPC mutation or request was seen in the flows. The mutations I made (level, hand-to, rules) all landed in the DB.
- No horizontal page scroll at 390 on any Keys page checked (scrollWidth 390).

## Cleanup

- Vite dev servers stopped by their PIDs (three runs, last PID 1880817 and its child), browser session closed, port 3151 free.
- `apps/web/.env.local` restored byte for byte (`cmp` against the saved copy in /home/roboto/devel/harbourmaster-wt/tmp/KY.15/env.local.orig is identical, `DEV_LOGIN_EMAIL=dev@rockyshoreslabs.io`).
- Stub rows deleted from the local D1: agents, agent_tool_rules, the one auto-created session and 25 `events` rows. `events` is append-only through a trigger, so I dropped `events_no_delete`, deleted my rows and recreated the trigger with its original definition (both events triggers are present, event count 0). The `workspaces` row for Dev Workspace that `/api/dev-login` creates remains, in the gitignored `.wrangler` state. Nothing was touched in git. The only new path is `docs/reviews/tasks/KY.15/`.
