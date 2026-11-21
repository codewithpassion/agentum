# FR end-to-end: fresh workspace walkthrough

Task FR.5, branch `task/FR.5-first-run-e2e`, from origin/main d9117cbd. Dev server on port 3917 (the port `PUBLIC_BASE_URL` names), a wiped local D1 for each size, dev login at `/api/dev-login`. The Anthropic key came from `apps/web/.env.local` into the masked field and is in no file. Screenshots are in `docs/reviews/FR-e2e/`, `desktop-<n>.png` at 1280x800 and `phone-<n>.png` at 390x844.

## Verdict

The path from nothing to a first answer works at both sizes, on the Cloud runtime. The "create a team from a starter" step cannot be done in the UI, because FR.2 shipped only the server side. I ran it through the tRPC calls instead, and the server works. One must-fix item.

## Walkthrough

| Step | Desktop | Phone |
|---|---|---|
| Dev login, empty Home with the two-step guide (desktop-1, phone-1) | Pass | Pass |
| Paste the Anthropic key, Done row with Manage keys (desktop-2, phone-2) | Pass, key accepted live | Pass |
| Pick the Inbox triage template, review screen filled (desktop-3, phone-3) | Pass | Pass |
| Choose where it runs, Create agent, land on the agent page (desktop-4/6, phone-4) | Pass | Pass |
| Send "Hi, say hello in one short sentence." and get an answer (desktop-8, phone-5) | Pass on Cloud. Fails on Anthropic cloud locally (finding 2) | Pass on Cloud |
| Create a team from a starter in the UI | Not possible, no entry (finding 1) | Same |
| Create a team from a starter through `agentBuilder.teamFromStarter` and `createTeam` (desktop-11, phone-7) | Sales team with 4 agents appears on /teams | Back office team with 4 agents appears |

Time and count. The commands from the dev login to the first answer took about 3 minutes of driver time at each size, most of it spent waiting between my own steps, so it is an upper bound, not a person's pace. The clicks were: save key (1), pick template (1), pick runtime (1), Create (1), type and send (2), 6 in all with one paste. The runtime pick is the only step that needs a decision the person has no help with. Nouns on the empty Home: AI account, API key, template, agent, Files, Spend, Find, Assistant, Needs you, about 9. After Create the agent page adds Chat, Work, Files, Knows, Keys, Jobs, Settings, task, conversation, library, skills, tools, so about 20 before the first answer if the person reads every tab.

Console and network: no errors at either size except one 400 from each of my own tRPC calls that I sent with a bad draft while probing the starter API. No other failed request.

## Friction list (inventory section 3) on this path

| # | Point | Status |
|---|---|---|
| 1 | No visible entry to most pages | Unchanged. Top bar shows Home, Files, Spend, Find. Teams has no entry there or on Home |
| 9 | A developer's first wall | Gone. The guide on Home takes the key and keeps the typed description |
| 10 | Plumbing words | Mostly remain. The builder still shows "Where it runs", "Anthropic cloud" and "Cloud", with no line telling them apart |
| 11 | Dense profile | Remains. Seven tabs on a new agent |
| 3 | Four words for one conversation | Remains. One screen says task, conversation, "Task 2 of 2" and Log |
| 14 | Raw titles | Not seen. The conversation title was the message text |
| 18 | About twenty nouns on day one | Better on Home (about 9), the same after Create |
| 4, 5, 6, 7, 8, 12, 13, 15, 16, 17 | | Not on this path, not checked |

## Findings

### Must-fix

1. There is no way to create a team from a starter in the UI. FR.2's scope was the service and the `agentBuilder.teamFromStarter` and `createTeam` calls only, and FR.4's review noted that the New team dialog does not offer starters. Nothing else wires them in, so the v4 milestone promise (two starters from the first-run plan) is not reachable by a person. The server side works: `teamFromStarter("sales")` returns four drafts, and `createTeam` makes the team with its lead once each member has a runtime (it answers "Settle Sales lead: Where it runs" until `runsOn` is set).

### Later

2. Local Cloud and Anthropic cloud runs need setup a new developer does not know about. Anthropic cloud failed with "PUBLIC_BASE_URL points at this machine, which Anthropic cannot reach" and Cloud failed with "PUBLIC_BASE_URL is http://localhost:3917, but this app runs on http://localhost:5287". Both messages are clear, but they are developer text shown in a person's conversation, and the dev server must run on 3917. CLAUDE.md or the dev docs should say so.
3. The runtime choice at Create is unexplained. "Anthropic cloud", "Cloud" and "Where it runs" appear with no help, and Create stays disabled until one is picked (FR.4's review lists the same).
4. A finished task shows stale state. After a Done answer the conversation list on the right still says "Running", and the Log tab reads "Log 0" and "Nothing logged yet" for a task that ran. Seen at both sizes.
5. A one-line "hello" cost $0.09 on one agent and under $0.01 on another. Same message, same key. The model or the cached prompt may explain it, but the person sees only the number.
6. The failed first message goes to Needs you and the badge counts it. That is correct, but the first thing a new person sees on Desk after a failure is "stopped before finishing" with no cause on the card.
7. `/login` shows the marketing page with no "Dev login" link in this build, so I used `/api/dev-login`. The project notes say the link exists.
8. Step 1 on Home shows a second "Anthropic API key" heading under the step heading (FR.3 nit, still there).
