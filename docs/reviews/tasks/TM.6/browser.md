# TM.6 browser verification

Commit a97682ce, branch task/TM.6-team-page. Vite dev on port 5391, dev login, Chromium headless via agent-browser (session tm6-verify). Desktop 1280x800, phone 390x844. Screenshots are in this folder: `desktop-<n>.png` and `phone-<n>.png` are the main shot of each flow, and `-a`, `-b` ... suffixes are intermediate states.

## Setup notes

- Dev login worked (`/api/dev-login`). The `/login` page showed no "Dev login" link in this headless run (only the newsletter form), so I opened `/api/dev-login` directly.
- Agent seed: `scripts/dev/seed-fake-agent.ts` made "Fake echo". The UI cannot create an agent on a clean DB: Start blank leaves Create agent disabled ("Nowhere to run it yet. Add an Anthropic API key or a machine in Settings"). I made the second agent ("Second Agent", runtime fake) with a throwaway script through the agents service. Job drafting in the UI also needs an Anthropic key, so I inserted one routine ("Every weekday at 9:00", agent Fake echo) into the local D1 `triggers` table with a throwaway script. Both scripts were deleted; the worktree git status stayed clean.
- For the duplicate-handle check I inserted one `member_profiles` row (handle `taken`) into the local D1.

## Flow 1. Find and Teams page

Steps: Ctrl+K, type "team"; click the Teams entry; look at /teams.
Desktop (desktop-1.png, desktop-1b.png, desktop-1c.png): palette shows a "Teams" group with a "Teams" entry (people icon) and one entry per team (Everyone, later Ops Team and Sales Crew). The Teams entry opens /teams. The page lists Everyone ("No members yet", "No lead") with an orange New team button. Later cards read "1 agent, 1 person / No lead" and "2 agents, 2 people / Second Agent leads".
Phone (phone-1.png, phone-1b.png): same group and entries, page fits, no horizontal scroll (390/390). Result: PASS both.

## Flow 2. Create a team

Steps: New team; name; tick both agents; pick lead; leave "Dev User (you)" ticked (it is ticked by default); Create team.
Desktop (desktop-2a/2b/2.png): the Lead select is disabled until an agent is ticked, then lists only the ticked agents. After Create team the app opened /teams/<id>. Header "Sales Crew / Second Agent leads." Members: Second Agent (Lead badge), Fake echo, Dev User (You). Shared folder shows `teams/sales-crew/` as a link to `/library?dir=teams%2Fsales-crew`; clicking it opened the Library at /teams/sales-crew (empty folder) (desktop-2c.png).
Phone (phone-2a/2b/2/2c/2d.png): "Phone Team" with lead Fake echo renamed, same members, folder link `teams/phone-team/` opens `/library?dir=teams%2Fphone-team`, Back returns to the team. PASS both.

## Flow 3. Members add and remove

Desktop: Add a person (Dev Member) then Add: row appeared, person dropdown lost that name (desktop-3a). Remove Fake echo: row gone, an "Add an agent" control appeared with Fake echo in it, and its standing job vanished (desktop-3b). Added Fake echo back with Add an agent. Remove the lead (Second Agent): header changed to "No lead." and the Lead select showed No lead (desktop-3c.png). PASS.
Phone: added Member Tester, removed Second Agent (row gone, Add an agent shown), removed the lead: header "No lead." (phone-3a, phone-3.png). Re-added both agents with Add an agent. PASS.

## Flow 4. Lead picker

Desktop (desktop-4a/4b/4.png): Fake echo -> "Fake echo leads."; No lead -> "No lead."; Second Agent -> "Second Agent leads." Each change saved without a reload.
Phone (phone-4a/4b/4.png): same three states. PASS both.

## Flow 5. Team rules

Desktop: typed "Always greet politely. Sales Crew rule ALPHA.", Save, "Saved." appeared (desktop-5a.png). Reload: text persisted (desktop-5b.png). Opened Ops Team through Find (client-side navigation): textarea empty (desktop-5.png). Then Find -> Sales Crew showed ALPHA again.
Phone: "Phone team rule BETA." saved, "Saved." shown, persisted after reload (phone-5a, 5b). Find -> Sales Crew showed ALPHA, not BETA (phone-5.png). PASS both. No leak between teams.

## Flow 6. Standing jobs

The only job belongs to Fake echo ("Every weekday at 9:00: Send a summary of yesterday").
Desktop: with Fake echo as a member the card shows "Fake echo / Every weekday at 9:00: Send a summary of yesterday" and an All jobs link (desktop-6b.png). After removing Fake echo the section says "No standing jobs yet." (desktop-6a.png). Second Agent, with no job, adds none. desktop-6.png is the member state.
Phone: Phone Team without Fake echo shows no job (phone-6a); after adding Fake echo the job shows (phone-6b); Ops Team (Second Agent only) shows "No standing jobs yet." (phone-6.png). PASS both.

## Flow 7. How the team knows you

Desktop: Name "Dom Dev", handle "Dom Dev" (with space): inline message "Use lowercase letters and digits, with single hyphens between them." and nothing saved (desktop-7a.png). Handle "DomDev": accepted and saved as `domdev` (the field lowercases it, so uppercase is normalised and not rejected). Reload: name "Dom Dev", handle "domdev" persisted (desktop-7.png). Handle `taken`, which another profile holds: "Handle is already used" (desktop-7b.png).
Phone: "Bad Handle" shows the format message (phone-7a), `taken` shows "Handle is already used" (phone-7b), `dom-phone` + "Dom Phone" saved with "Saved.", persisted after reload and shows on other teams (phone-7.png). PASS both.

## Flow 8. Everyone team

/teams/<Everyone id> shows "This team has no shared folder." under Shared folder, "No members yet.", Lead select disabled with "Add an agent to the team to choose a lead.", and your profile fields filled (desktop-8.png, phone-8.png). PASS both.

## Flow 9. Agent Settings tab

Desktop (Fake echo): Capability, Thinking level, Context size are on /agents/<id>?tab=settings. Picked Thorough and Large: "Saved" toast each time (desktop-9b, 9c); Balanced capability also toasted. After reload: Balanced / Thorough / Large (desktop-9e.png; one earlier run lost a value, see finding 1). Set Fast and cheap / Thorough / Small, then the Edit agent form on the same tab: name changed to "Fake echo renamed", Save changes; capability, thinking and context were unchanged after the save and after reload (desktop-9g, desktop-9.png).
Phone (Second Agent, fake model): initial state shows "Custom (fake)" for Capability (phone-9a.png). Picked Balanced thinking, Standard context, Most capable: all persisted after reload (phone-9b.png). Renamed to "Second Agent X" in the Edit agent form with Save changes: settings still Most capable / Balanced / Standard after save and reload (phone-9.png). PASS both.

## Layout

No horizontal scroll at either size (scrollWidth equals innerWidth: 1280/1280 and 390/390) on /home, /teams, every team page, Everyone, the agent Settings tab and the Library folder page. Nothing overlapped. The round badge at the bottom right is the dev tools button and sits over empty space.

## Console and network

Console: no error on /teams, a team page, Everyone, the agent Settings tab or the Library page after a clean load (each checked with the log cleared). Three errors in the full desktop run and one in the phone run, all explained:
- `400` on `/api/dev-login` (two on desktop, from sign-in; reproduced on every dev login, Clerk dev instance, out of scope).
- `409 (Conflict)` "Failed to load resource" each time I submitted the already-used handle `taken`. This is the server answering a deliberate duplicate, and the UI shows "Handle is already used". The browser logs it because the tRPC call returns a 409.
Warnings: Clerk development keys and React DevTools hint only.
Network: agent-browser lists requests without status codes. The dev server log has no 4xx or 5xx lines. No failed team, agent or library request showed in the console apart from the 409 above. No favicon request was noticed.

## Findings

1. Minor, race on the Settings tab. Picking a second choice right after the first (about 1 second apart, while the first save is in flight) can lose the first. Repro: on /agents/<id>?tab=settings with Thinking = Thorough, run `select Thinking level = Quick` then immediately `select Context size = Small`. Result: Context = Small, Thinking stays Thorough. Expected: Quick and Small. Cause (from `components/agent/room/settings/plain-choices.tsx`): each handler builds the full `runtimeConfig` from props (`withContextBudget(runtimeConfig, ...)`), so a change made before `router.invalidate()` has refreshed the props saves a config that lacks the first change. The select shows the old value until the save and reload finish (~1.5s in dev), so a person is unlikely to hit it, and with a 3 second pause between choices all values persisted every time. Not a blocker.
2. Note, not a defect: uppercase handle input is lowercased and saved, not rejected. The task text expected a message for uppercase; the message appears for spaces.
3. Note: on a clean DB the UI cannot create the first agent without an Anthropic key or machine, and the /login page did not show the dev-login link in this headless run.

## Verdict

PASS. All nine flows work at 1280x800 and 390x844, there is no horizontal scroll or overlap, and no console error comes from the team, agent or library pages. The only logged errors are the Clerk dev-login 400 (out of scope) and the 409 from the deliberate duplicate-handle test. Finding 1 is a minor race the developer may want to fix.

## Re-check after the Settings race fix (02235f72)

Vite dev on port 5400, dev login, agent-browser session tm6-verify2, agent "Fake echo" from `seed-fake-agent.ts`. Each pair of picks was two back-to-back `select` commands chained with `&&` (no pause), then a 3 second wait and a full reload. Screenshots: `recheck-desktop-1/2/3.png`, `recheck-phone-1/2/3.png` (1 = after pair, 2 = capability pair, 3 = after Edit agent save).

Steps and results (Capability / Thinking / Context read from the selects after reload):
1. Thinking Quick then Context Small (start Fast and cheap / Thorough / Standard): desktop Fast and cheap / Quick / Small, both persisted. Context Large then Thinking Thorough: desktop Fast and cheap / Thorough / Large, both persisted. Phone: Thinking Balanced then Context Small gave Balanced / Balanced / Small; Context Large then Thinking Thorough gave Balanced / Thorough / Large. Both persisted.
2. Capability then Thinking straight after: desktop Balanced + Quick gave Balanced / Quick / Large; phone Most capable + Quick gave Most capable / Quick / Large. Both persisted after reload.
3. Edit agent, name changed (desktop "Fake echo renamed d", phone "Fake echo phone"), Save changes: Capability, Thinking and Context unchanged straight after the save and after a reload; new name shown.

Console: no error entries at either size, only the Clerk development-keys warning, React DevTools hint, vite debug lines and a software WebGL warning. Dev log: no error or 4xx/5xx line (only docker build output from wrangler containers).

Verdict: PASS. The race no longer reproduces at 1280x800 or 390x844. Phone note: the select refs differ from desktop, which only mattered for the test script.
