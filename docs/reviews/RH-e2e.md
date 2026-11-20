# RH end-to-end walkthrough

Task RH.7. Verdict: the Roster flow works on local at 1280x800 and 390x844. A person lands on home, describes an agent, sees its card, opens it, chats with it, answers one of its questions from the Needs you drawer, and watches the card change. RH.3's open item is closed: on real roster data the wall sorts needs_you, stopped, working, idle, with ties by name. Two small defects were fixed on the branch. Four things are proposed as tasks below. Staging was not run (it needs a deploy, see "Steps for Dom").

The browser proof, step by step with screenshots at both sizes, is `docs/reviews/tasks/RH.7/browser.md`. A fresh verifier, who did not build RH, ran it.

## What was real and what was not

- The drafter ran on the real Anthropic key. The dev key was entered through Settings, Model providers, into the local dev database only. The field masks it and nothing in the docs or screenshots shows it.
- Fake echo (`bun scripts/dev/seed-fake-agent.ts`) answered Chat with "Echo: <input>".
- Cloud (Pi) agents made real Anthropic calls. One wrote a 1500-word article in 64 seconds for $0.07.
- The Needs you question was raised by a real agent. A drafted Cloud agent called its `ask_user` tool, which opened a `question` request, and the drawer showed it. Nothing was seeded by hand.
- The Anthropic cloud (managed) runtime was not run. It needs a public tunnel on local, and the app says so in plain words.
- A stopped agent paused at its weekly cap was not exercised. "Stopped" came from a failed run.

## Result by flow

| Flow | Result |
|---|---|
| Land on home | Pass. An empty roster shows the first-run guide. |
| Create an agent by describing it | Pass. The drafter named "Lunch Planner" and "Standup Helper" from one sentence. Create agent opened the room. |
| Card on the wall | Pass. Avatar, name, state, job line, status line, owner, week cost. Needs you chips sit in a row above the wall. |
| Open the agent | Pass. All seven tabs load. |
| Chat | Pass on Fake echo and on Cloud agents. |
| Answer a question from Needs you | Pass. The item leaves the drawer, the count drops, the run carries on. |
| Card state change | Pass. Needs you, first on the wall, then Idle, last, with the chip gone. The card and the drawer agreed each time. |
| State sort on real data | Pass. All four states at once from real runs, wall order and `roster.list` matched the rule. |

At 390 px no page scrolled sideways, including `/home`, the agent room with all seven tabs, `/threads/<id>` and `/desk?item=<id>`. The task page overflow found in the KY walkthrough is gone, so RH.6 fixed it. No request failed. The console held no app error. The only console errors came from a mismatched `PUBLIC_BASE_URL` in the verifier's setup (see "Things to know").

## Fixed on this branch

- A card's job line was cut at 80 characters in the middle of a word with no ellipsis, and a first sentence that ended in `?"` was not found. A clipped line now ends in an ellipsis (still 80 characters at most) and a sentence end may be followed by a closing quote or bracket. `jobLineFor` in `packages/services/src/roster.ts`, with tests in `roster.test.ts`. The Jobs tab shares the function, so its "does" text gets the ellipsis too (`jobs.test.ts` changed to match).
- A card whose owner is not a member printed "Owner" with nothing after it. The label is now hidden when there is no name. `agent-card.tsx`, with a test.

## Proposed tasks

### One avatar for an agent everywhere

Finding. The home card draws the stored avatar (colour and glyph, from RH.1). The room header, the builder's draft card, the rail, the Needs you cards, the desk cards and the task receipt draw initials and a colour taken from the name (`shell/agent-tile.ts`). One agent shows two avatars: Lunch Planner is a green "L" on the wall and a violet "LP" in its room. The stored avatar is not on `AgentRecord` or the profile header, so the room cannot read it yet.

Scope. Carry `avatar` on the agent profile header and the other agent reads, replace `agentInitials` and `agentTileColour` with one shared component fed by the stored avatar (the draft card uses `defaultAgentAvatar(name)`), and delete the name-derived helpers.

Check. Component tests for the shared tile. Browser: create an agent, compare its card, room header, Needs you entry and task receipt.

### One time zone rule for what the app prints

Finding. Chat and task times print the UTC `HH:MM` of the ISO string (`slice(11, 16)` in `components/thread/task-thread.tsx`, `components/task/thread-runs.tsx`, `components/task/task-page.tsx` and `components/requests/request-card-logic.ts`). At 20:13 in Sydney the chat said 09:13. The desk pane's "How it got here" uses the browser's zone. The card status line uses the workspace zone (UTC by default). Three zones on one screen.

Scope. Decide first which zone the app shows, the browser's or the workspace's. Then add one formatter and use it in all of those files plus `components/task/files-logic.ts` and `components/task/action-log.tsx`, which slice the ISO string the same way.

Check. Unit tests for the formatter. Browser: send a chat message and read its time, the desk pane's time and the card's status line, all the same hour.

### The Find dialog's hidden heading is on every page

Finding. The Find command dialog's screen-reader heading ("Find") is in the page while the dialog is closed, because shadcn's `CommandDialog` puts its sr-only `DialogHeader` outside `DialogContent`. A screen reader hears a stray "Find" heading on every page. The file is shadcn output, so it cannot be hand-edited.

Scope. Build the dialog from `Dialog` and `Command` in our own wrapper outside `components/ui/`, with the title inside `DialogContent`. Low priority.

Check. A component test that the heading is absent while closed. Browser: no "Find" heading in the page outline.

### Cloud runs on any dev port

Finding. `apps/web/.env.local` sets `PUBLIC_BASE_URL=http://localhost:3917` for the Pi durability e2e. On any other port a Cloud run never starts: the MCP server URL fixed into the run points at 3917, the log repeats "PiRun: MCP server harbourmaster did not list its tools Network connection lost", and the run shows "Working" with an empty log until the two-minute start timeout. Worktrees must run on their own port (workflow.md), so every walkthrough that uses a Cloud agent hits this.

Scope. In dev, fail the run fast with a message that names the port mismatch when `PUBLIC_BASE_URL` is a localhost address that does not match the request's origin.

Check. A test with a mismatched localhost URL. Browser: a Cloud agent on a non-default port fails within seconds with the message.

## Nits left alone

- At 390 px the TanStack Devtools button (dev builds only) covers the thread composer's Send button. Ctrl+Enter works.
- Anthropic cloud (managed) is the builder's default runtime and cannot run on local. The error says to run a tunnel. A first-time developer may prefer the builder to pick Cloud on local.

## Things to know about running this walkthrough

- agent-browser here shares one default Chrome profile, so give every session its own `--profile` folder.
- Start vite with `CLOUDFLARE_INCLUDE_PROCESS_ENV=true PUBLIC_BASE_URL=http://localhost:<port>` so Cloud runs reach the app (the last proposed task).
- To raise a question from a real agent, tell a Cloud agent: "use your ask_user tool to ask me X, with A and B as choices". The request shows in Needs you within a few seconds.
- `wait --load networkidle` never settles because the page polls. The verifier read failed requests from `performance` entries with `responseStatus >= 400`.

## Steps for Dom

- After deploy, repeat the walkthrough on staging with a real member: describe an agent, chat with it, answer a question from the drawer. Include an agent on the Anthropic cloud (managed) runtime, which local could not run.
- Decide the time zone rule (second proposed task).
