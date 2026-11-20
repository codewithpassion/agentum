# NV.6 browser check

I ran commit 9064ae9 with `vite dev` on port 3461 against a fresh local D1, migrated first, and signed in with the dev login as "Dev Workspace". The browser was headless Chrome driven by agent-browser.

Screenshot numbers: n=1 is the task page header, n=2 is the builder with nowhere to run, n=3 is the agent's secrets copy. Extra shots are `desktop-1-fake.png`, `desktop-1-cloud.png`, `desktop-1-machine.png`, `desktop-2-draft-card.png` and `phone-2-draft-card.png`.

## Flow 1: task page "Runs on"

Setup. `bun scripts/dev/seed-fake-agent.ts` created the "Fake echo" agent with runtime `fake`. I pressed Run now on its profile and started a task ("Say hello."). It finished with "Echo: Say hello.". `/tasks/<runId>` opens the task inside its conversation at `/threads/<sessionId>`. To check each label, I changed this agent's `runtime` column in the local sqlite file and reloaded the page. So there is one agent with one run, and the agent has no machine.

- Desktop 1280x800. With `managed`, the header reads "Fake echo · Started by Dev User · Anthropic cloud · 08:19, took 0s · not reported this task" (`desktop-1.png`). With `fake` it says "Test runner", with `cloud` "Cloud", and with `machine` and no machine "My computer" (`desktop-1-fake.png`, `desktop-1-cloud.png`, `desktop-1-machine.png`). Pass.
- Phone 390x844. The page renders with no horizontal scroll (scrollWidth 390). The phone header shows only status, agent name and time (`phone-1.png`). `task-page.tsx` hides the whole meta line, "Runs on" included, below `md` (`hidden md:flex`). NV.6 did not change that, and `runsOnText` has no other call site. So I could not check the label at phone width. The spec's own browser check asks for desktop width only.

## Flow 2: builder with nowhere to run

`agentBuilder.catalog` builds the runtime options. `machine` needs a machine that is not revoked and has the `agent_host` role. `managed` needs a workspace Anthropic key, which lives in D1 (`workspace_anthropic_keys`). The `ANTHROPIC_API_KEY` in `.env.local` does not count. `cloud` needs that key or a workspace OpenRouter key (`workspace_model_keys`). Throughout the check, `workspace_anthropic_keys`, `workspace_model_keys` and `machines` had 0 rows, so the list was empty.

- Desktop, Start blank. I opened New agent, then Start blank. Under "Runs on" it reads "Nowhere to run it yet. Add an Anthropic API key or a machine in Settings." and never says "runtime" (`desktop-2.png`). Pass.
- Phone, Start blank. Same steps. The line wraps inside the card, with no horizontal scroll (`phone-2.png`). Pass.
- Draft card. Describe it, then Draft, needs an Anthropic key. Without one the page shows the alert "This workspace has no Anthropic API key..." and no card appears. Picking a template ("Invoice filing" on desktop, "Weekly report" on phone) builds the draft without a model call. In both, the card's "Runs on" row shows the same "Nowhere to run it yet..." line, followed by a "Where it runs" decision chip (`desktop-2-draft-card.png`, `phone-2-draft-card.png`). Pass at both sizes.

## Flow 3: secrets copy

I opened the agent profile, then the Keys tab, then the "Passwords and keys" section. It reads "...An env secret is set as an environment variable for agents on My computer and Linux VM agents...". The paragraph wraps cleanly at both sizes (`desktop-3.png`, `phone-3.png`). Pass. `RuntimeNotes` ("Agents on My computer receive env secrets...") did not render, because the agent has no granted secret, so I did not see that string.

## Console and network

The console showed Vite debug lines, the React DevTools info line and Clerk's development-keys warning. No page errors appeared. I read status codes from the local Worker's observability spans. Every Worker request returned 2xx or 3xx, except these two 400s:

- `POST /api/trpc/agentBuilder.draft` returned 400 when I pressed Draft with no Anthropic key. That is the app's intended "no key" error, and the page showed it as an alert. It was an extra probe for the draft card, outside flows 1 to 3.
- During sign-in, on the `/dev-login` page, the console logged "Failed to load resource: 400" both times I signed in. It was not a Worker request. The only non-GET requests on that page went to the Clerk dev instance (`/v1/client/sign_ins` and `/v1/environment`). I could not confirm which request failed. It happens before any flow page loads.

Verdict: pass. The verifier reported fail on the strict rule only, because the "Runs on" label is not rendered at phone width (`hidden md:flex` in `task-page.tsx`, unchanged by NV.6) and the task's browser check asks for desktop width only for that flow. The dispatcher accepts desktop-only for flow 1 and flags it to the controller. The two 400s above come from an intended "no key" probe and a Clerk dev-login request, not from the flow pages.
