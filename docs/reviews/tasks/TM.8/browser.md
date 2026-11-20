# TM.8 browser verification (round 2)

Verifier: independent, agent-browser session `tm8-verify2`, headless Chrome 156, dev server `vite dev --port 4317` from this worktree (head b29d73f8), fresh `.wrangler`, migrations applied. Signed in through `/api/dev-login` (dev workspace). Screenshots are in this folder. Data was seeded by calling the app's own tRPC API from the signed-in page (`agents.create`, `teams.create`, `teams.addMember`, `teams.setLead`, `agents.list`, `teams.list`).

Seed data: 7 agents (Alice Analyst, Bob Builder, Carla Closer, Dmitri Docs, Eva Edits, Femi Finance, Gus General). Teams: Alpha Sales (lead Alice; Alice, Bob, Carla), Beta Support (lead Dmitri; Dmitri, Eva), Solo Ops (no lead; Femi), the built-in Everyone (no home members), later a long-named team. Gus started in no team. For flow E I added 8 more agents ("Extra Agent 1..8", no team) and the team "Customer Success and Onboarding Operations Group" led by "Bartholomew Montgomery-Featherstonehaugh the Third".

How errors were checked: the agent-browser request log (`network requests`) has no status codes, so failed requests were checked three ways: `agent-browser console` (Chrome logs every 4xx/5xx sub-resource as "Failed to load resource ... status N"), `performance.getEntriesByType("resource")` filtered on `responseStatus >= 400` after each step, and the dev server log. Statuses of my own tRPC calls were read from the JSON bodies.

## Flow A: agents, no team at all

Setup: I deleted the Everyone row with `wrangler d1 execute DB --local` (after saving the row to `tmp/TM.8/everyone-row.json`), and re-inserted it with the same id and columns afterwards. `teams.list` shows Everyone again.

Steps: opened `/home` with 7 agents and zero teams.

- Desktop 1280x800 (`desktop-1.png`): one flat 3-column wall of 7 cards, then the dashed "New agent" and "Start from a template" cards. No group headings (only `H1 Home`), no `aria-expanded` group buttons, no "Add to team" card, no "Lead" badge. `scrollWidth` 1280. Pass.
- Phone 390x844 (`phone-1.png`): same flat single column, no headings, `scrollWidth` 390. Pass.

Side observation (not a defect): with the Everyone team present but holding no home members, Home shows an "Everyone" group ("No lead · 0 agents", Open room, Add to team) above "No team". This is how the earlier round described real data.

## Flow B: two teams plus an agent in no team

Steps: `/home` with Alpha Sales, Beta Support, Everyone, Solo Ops, 6 agents in teams, Gus in no team.

- Desktop (`desktop-2.png`, full page): groups in team-name order: Alpha Sales, Beta Support, Everyone, Solo Ops, then "No team" last. Summary lines: "Lead Alice Analyst · 3 agents", "Lead Dmitri Docs · 2 agents", "No lead · 0 agents", "No lead · 1 agent", and "1 agent" under No team. "Lead" badge only on Alice and Dmitri. Open room links have hrefs `/teams/<teamId>/room` for all four teams (ids match `teams.list`). Each team group ends with a dashed "Add to team" card (it sits in the next grid slot, or on its own row when the row is full). "New agent" and "Start from a template" dashed cards are last. Pass.
- Phone (`phone-2.png`, full page): same order and content in one column, Open room button right of the heading, `scrollWidth` 390. Pass.
- The "M need you" part of the summary line did not appear, because no agent had a pending request (it is omitted at zero). I could not create a Needs you item in the browser. The text is covered by `team-group.test.tsx` ("2 need you", "1 agent · 3 need you"), not by this browser run.

## Flow C: collapse and remember

- Desktop (`desktop-3.png`, `desktop-3b-reloaded.png`): clicked the "Beta Support" heading button. Its cards and Add to team card disappear (heading, summary and Open room remain), the other groups are unchanged, and `aria-expanded` is `"false"` on the collapsed button and `"true"` on the others (the playwright snapshot shows `[expanded]` only on the open ones). localStorage key `hm:roster-collapsed:user_3Kk8S5uJZvRLPGiEoZ8ZfJfCH8m` = `["<Beta Support id>"]`. After reload it stayed collapsed. Clicking again expanded it and the value became `[]`. Pass.
- Phone (`phone-3.png`, `phone-3b-reloaded.png`): collapsed Beta Support, key written, still collapsed after reload, expanded again (`aria-expanded` back to `"true"`). Repeated in a clean pass with Alpha Sales at both sizes with no errors. Pass.
- Minor: a collapsed heading button has no `aria-controls` (only the expanded one has it). Harmless.

## Flow D: Add to team

- Desktop (`desktop-4.png`): clicked "Add to team Solo Ops". Dialog "Add to Solo Ops" lists the six agents not in Solo Ops (Femi is absent), each with its team ("In Alpha Sales" and so on; Gus General has none). Picked Gus General: the dialog closed (0 dialogs) and after the refresh Gus's card is in Solo Ops ("2 agents"), and the "No team" group vanished since it was empty (`desktop-4b-after-add.png`). Empty state: I added every agent to Everyone (non-home) and opened "Add to team Everyone": the text reads "Every agent is already in this team." (`desktop-4c-empty.png`). Escape closes the dialog. Pass.
- Phone (`phone-4.png`, `phone-4b-after-add.png`, `phone-4c-empty.png`): after resetting Gus to no team, same sequence. Dialog spans x 16..374, y 158..686 of 844, fits. Picking Gus closed the dialog and moved him into Solo Ops. Empty message identical. Pass.
- A clean second pass (Alpha Sales dialog, pick Extra Agent 1 on desktop, Extra Agent 2 on phone) also closed the dialog and showed the agent in Alpha Sales, with no console error and no 4xx.
- Side observation, backend not Home: `teams.removeMember` on an agent's home team promotes another membership (Everyone) to home. After removing Gus from Solo Ops he showed in the Everyone group, not No team. I removed him from Everyone too to get him back to no team.

## Flow E: long team name, phone

- Phone (`phone-5.png`, full page): "Customer Success and Onboarding Operations Group" heading truncates with an ellipsis ("Customer Success and Onboarding Ope..."), the summary wraps to two lines ("Lead Bartholomew Montgomery-Featherstonehaugh the Third · 1 agent"), the Open room button drops below it, the lead's card name truncates, the Lead badge stays visible. `document.documentElement.scrollWidth` 390 = viewport, `body.scrollWidth` 390. The only elements wider than the viewport are off-screen toast containers (`go...` classes), not part of Home. Pass.
- Phone dialog (`phone-5b-dialog.png`, `phone-5c-dialog-scrolled.png`): with 16 candidates the dialog "Add to Customer Success and Onboarding Operations Group" is 812px tall inside an 844px viewport (x 16..374), the long title wraps onto two lines beside the close button, and the dialog scrolls (`overflow-y: auto`, scrollHeight 1116) so every agent is reachable. The whole dialog scrolls, so the title and close button scroll out of view; Escape still closes it. Page `scrollWidth` stays 390. Pass.
- Desktop (`desktop-5.png`, `desktop-5b-dialog.png`): heading shows the full name on one line, `scrollWidth` 1280. 8-agent "No team" wall and the bottom cards look right. Pass.
- Nit: on a phone the long team name is cut off with no way to read it on the Home heading (no wrap). Optional.

## Console and network

- Clean passes (load, collapse, reload, expand, add dialog, at 1280 and 390): no console errors, and no resource with status >= 400. Only console warnings: Clerk development keys, headless WebGL fallback, "No available adapters", `[vite]` debug lines.
- Over the whole session `agent-browser console` showed 18 error lines, none from a Home interaction:
  - 2 x "Failed to load resource ... 400" appear right after each `/api/dev-login` redirect (the Clerk sign-in token redemption), before Home renders. Both happened only on a dev-login load.
  - 16 x "Failed to load resource ... 401 (Unauthorized)" in one burst, together with a Clerk warning `useOrganizationList requires an active user session`. The browser's Clerk session lapsed on its own after about five minutes of testing (my 8 `agents.create` calls in that window returned `UNAUTHORIZED`, which is eight of the sixteen). Re-running `/api/dev-login` restored it. I believe this is the dev Clerk session, not TM.8 code, but I did not prove it.
- The dev server log has no errors. No request to `/teams/<id>/room` was made (I checked only the hrefs). The TanStack Devtools palm button overlaps the right edge on every screenshot; it is a dev-build overlay, out of scope.

## Verdict

Pass for TM.8. Every flow works at both sizes, Everyone is back in the local database, and the Home page itself produced no console error and no failed request. Strictly, the session log does contain the 400s (dev-login redirect) and 401s (expired dev session) above, and the "M need you" text was not seen in the browser, so apply the stricter rule if you read it literally.

No defects found. Nits: heading text is cut off for very long team names on a phone, the add dialog's title and close button scroll away with a long list, and a collapsed heading has no `aria-controls`.
