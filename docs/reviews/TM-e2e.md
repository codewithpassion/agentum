# TM end-to-end walkthrough

Task TM.10. Verdict: the Teams walkthrough passes on local at 1280x800 and 390x844. Every step in the scope worked. The steps that need a lead to use tools could only run with help, because the fake runtime cannot call tools (see "What was real"). The browser proof, step by step with screenshots, is `docs/reviews/tasks/TM.10/browser.md`. A fresh verifier ran it, then a second round closed the two hidden-from-a-non-member checks in the UI.

## What was real and what was not

- The agents were fake-runtime agents, seeded with `bun scripts/dev/seed-fake-agent.ts <slug> <name>` (this task added the two optional arguments). The UI cannot create a fake agent.
- The fake runtime echoes its whole input. So the lead "assigned" because the team rules held `@writer-bo @checker-cy`, and the echoed reply carried the mentions. The real machinery ran after that: the lead heard a post that named nobody, its post showed "Assigned to", the members woke and answered with task links, and a later `@checker-cy` post caught up on earlier posts.
- The lead's proposal did not come from a model. `bun scripts/dev/team-propose.ts` marks the lead's newest room run as running, signs a run token and calls the real `/mcp` route (`team_propose_change`, also `team_open_topic` and `team_post`). The tool, the port, the service and the approval request are real. The owner then approved or denied in the browser, and the member's instructions changed (or did not) in the database and on the agent page.
- A limited topic and a hidden task were made by having the lead open a topic that leaves the signed-in person out. The signed-in person then saw no topic in the room, an empty room at the topic's URL, and "Task not found" on the run's task page, at both sizes. A real second person was not signed in. The service tests (`inbox.test.ts`, limited topic and run visibility) cover two principals.

## Result by step

| Step | Result |
|---|---|
| Team of three agents with a lead | Created from New team. Rules saved. |
| Post naming nobody | The lead answered, its post named Writer Bo and Checker Cy under "Assigned to", both woke and answered with task chips that open the task. |
| Mention a member | Only the member answered. Its input held the earlier posts inside the untrusted block. |
| Lead proposes an instruction change | A pending request reached the owner. Allow once applied it. Deny left the instructions alone. `field: connectors` was refused by the tool's schema. |
| Limited topic hidden from a non-member | Hidden in the topic list and at its URL. An agent left out of a topic was not woken by a mention. |
| Task link hidden | "Task not found. This task does not exist, or you cannot see it." |

Console: no errors apart from the devtools source opener (400). The first verifier saw two 500s and a Slack card log, all "database is locked", while the script and a `sqlite3` read held the local database. They did not recur.

## Proposed tasks

### TM.12 The lead's proposal card says what it proposes

Finding. A lead's proposal shows as the generic permission card, "Writer Bo asks before team propose change". Writer Bo is the target, not the asker. The buttons are Allow once, Always allow and Deny, and "Always allow" says it saves a rule, which makes no sense for a settings change. The field, the new value, the reason and the lead's name are only in a collapsed raw JSON "Input". The server already refuses "Always allow" for a proposal (`requests.ts`, "Allow it once instead"), so the button is offered and then fails. The verifier saw the card in Needs you and on `/desk?item=<id>` but not in the room. The room (`room-requests.tsx`) does list pending requests of the topic's sessions, and `team-propose.ts` attaches the card to the lead's newest room run in any topic, so the card probably sat in another topic. Not re-checked; look in the run's own topic first.

Scope. In `components/requests/request-card.tsx`, recognise a team proposal (`isTeamProposal` in `packages/services/src/teams/proposal.ts`) and render "Lead Ann proposes a change to Writer Bo", the field, the old and new value and the reason, with Approve and Reject and no "Always allow" button (a UI change only, the server already refuses it).

Check. Component test for the proposal card. Browser: the lead proposes, the owner reads and approves from the room.

### TM.13 "Assigned to" names only people who can see the topic

Finding. In a limited topic, a lead post that mentions a person outside the topic still shows "Assigned to Writer Bo, Checker Cy" although Checker Cy is not in the topic and was never woken.

Scope. Where the room builds the assigned list (`room-logic.ts`), keep only mentioned members who are in the topic.

Check. `room-logic.test.ts`: a mention of a non-member is not listed.

### TM.14 Fake runtime for a team lead

Finding. The fake runtime cannot call team tools, so the "lead answers and assigns" and "lead proposes" steps need the rules trick and `team-propose.ts`. Nobody can watch a lead use its tools without a model.

Scope. A third fake mode (like `fake-tool`, KY.9) for a lead's room run: text such as `assign:@handle` makes it call `team_post` and `team_propose_change:<field>=<value>` calls `team_propose_change` through its own run token. Then `team-propose.ts` can go.

Check. A runs test with the scripted text. Browser: the walkthrough with no script.

### TM.15 Dictation in the room composer

Finding (from TM.9's log). The old inbox composer (`components/inbox/post-composer.tsx`, removed in TM.9) had dictation. The room's `mention-composer.tsx` has none, and every other prompt box does (DT.2).

Scope. Add `DictationButton` and `DictationPreview` to the room composer, as `composer-container.tsx` does. Decision: yes, it should.

Check. A test that the button shows, and the browser at both sizes.

### TM.16 Phone room layout

Finding. At 390x844 the sticky composer takes about 200px of the height and hides the last task chip. The topics sheet stays open after New topic creates a topic and closes only when a topic is tapped.

Scope. Shrink the composer on phone (one line until focused) and close the sheet when a topic is created.

Check. Browser at 390x844.

## Findings on the TM log notes

- Compaction setting. Claude Code 2.1.327 has `--autocompact <auto|tokens>` ("auto, or at least 100k tokens") in `claude --help`. The client still passes only `--effort`, and `apps/agentum/src/claude.rs` notes the flag is not known in every version it accepts. The guessed sizes (100k, 200k, 500k) are all at or above the 100k minimum. Passing the flag needs a version check: pass it when `claude --version` is at least 2.1.327 (the version checked here), and leave it out below that. That is a small change in `claude.rs` and not part of this walkthrough. The context budget still does nothing on machine runs until then.
- Dictation: see TM.15.

## Nits left alone

- There is no "lead listens" checkbox on the team page, only the sentence "The lead hears room messages that name nobody" under the Lead picker. The setting exists in the service (`lead_listens`) and in the tests, so the page may be missing a switch.
- With fake agents the echoes cascade: members wake each other because every echo carries the rules' mentions. Expected with the fake runtime, and it stops at the loop guard.
- `/login` never reached networkidle in the headless browser. The verifier opened `/api/dev-login` directly.

## Things to know about running this walkthrough

- Start the dev server on a free port, sign in with `/api/dev-login`, and seed three agents with `seed-fake-agent.ts <slug> <name>`. This host needs `AGENT_BROWSER_EXECUTABLE_PATH` pointing at the headless shell under `~/.cache/ms-playwright/chromium_headless_shell-1248/`.
- Do not run `sqlite3` or `team-propose.ts` while the page is loading. The local database is locked for writes and the page logs 500s.
- Until RH.11 lands, a Cloud agent also needs `CLOUDFLARE_INCLUDE_PROCESS_ENV=true PUBLIC_BASE_URL=http://localhost:<port>`. This walkthrough used only fake agents.
