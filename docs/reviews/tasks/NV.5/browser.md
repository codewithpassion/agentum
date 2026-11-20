# NV.5 browser check

Verdict: **pass**

Every intended wording below matched at 1280x800 and at 390x844. The flows show no console errors and no failed requests (details under "Console and network"). One thing differs from the brief: Start blank has no dry run note. The note lives in the builder's draft review ("Describe it" or a template), and that is where it was checked.

Branch task/NV.5-finish-agent-flow-words at 1e017759. Local `vite dev` on port 5217, signed in through "Dev login (local only)", agent-browser session `nv5-verify`.

## Setup

- On Home I saved the Anthropic API key from `apps/web/.env.local` to the local workspace. A dummy key was rejected first ("Anthropic did not accept that key"), which explains the one 400 in the console. Without a key the builder offers no Cloud or Anthropic cloud option.
- I inserted one machine row into local D1, because the UI cannot enroll a machine without a daemon: `machines` id `01NV5VERIFYMACHINE00000001`, name "Dom laptop", status `online`, a 64-zero hex `credential_hash` (gives it the agent_host role), capabilities `{}`, workspace `01M7VN99DVE7HDJXNJ7X9ZBFEA`.
- I created three agents through the UI. "Inbox triage" runs on My computer: Dom laptop (made from the template draft). "Cloud helper" runs on Cloud and "Anthropic helper" runs on Anthropic cloud (both made with Start blank).
- I set Cloud helper's model to GLM-5.3 in its edit form and saved, so the Move dialog would ask for an Anthropic model.
- I created an env secret TEST_TOKEN (allowed host api.example.com) under Settings, Passwords and keys, so the Keys tab shows the secrets notes.

## Screenshots

Each number is the same flow at both sizes (`desktop-<n>.png`, `phone-<n>.png`).

| n | Flow |
|---|------|
| 1 | Builder draft (Inbox triage template), Cloud chip picked, dry run note |
| 2 | Builder draft, Anthropic cloud chip, dry run note |
| 3 | Builder draft, My computer: Dom laptop chip, dry run note |
| 4 | Start blank form with Runs on chips (it has no dry run note) |
| 5 | Edit form (Settings tab) of the Anthropic cloud agent: Runs on and its note |
| 6 | Edit form of the Cloud agent, Advanced opened: Turn limit |
| 7 | Cloud agent header and Runs on card |
| 8 | Move dialog for the Cloud agent (GLM model): model notice |
| 9 | Move dialog for the Anthropic cloud agent, target Cloud: Cloud note |
| 10 | Anthropic cloud agent header and Runs on card |
| 11 | Keys tab of the Anthropic cloud agent: secrets notes |
| 12 | Machine agent header and Runs on card |
| 13 | Machine agent edit form: Runs on |
| 14 | Settings, Model providers |
| 15 | Map, agent cards |
| 16 | Map inspector for the machine agent (a panel at desktop width, a sheet at phone width) |

## Flows

1. Dry run note in the builder (1-3), pass at both sizes. Steps: Agents, New, Describe it, pick the "Inbox triage" template, then pick each Runs on chip in turn.
   - Cloud: "The dry run runs on Cloud, where you chose to run it."
   - Anthropic cloud: "The dry run runs on Cloud. Anthropic cloud cannot run a dry run yet, so the real agent runs there."
   - My computer: "The dry run runs on Cloud. Dom laptop cannot run a dry run yet, so the real agent runs there."
   - With no chip picked: "The dry run runs on Cloud."
   - "Cloudflare" does not appear anywhere.
2. Start blank (4), pass at both sizes. The chips read "Anthropic cloud", "Cloud" and "My computer: Dom laptop", under the label "Runs on". The form has no dry run note.
3. Edit form, Runs on (5, 13), pass at both sizes. Edit opens the Settings tab, which holds the inline edit form.
   - Cloud agent: "Runs on" then "Cloud".
   - Anthropic cloud agent: "Runs on" then "Anthropic cloud". The note opens with "In Anthropic's cloud, not on one of your machines." and ends with "A conversation stops at $10 of spend."
   - Machine agent: "Runs on" then "My computer: Dom laptop".
4. Advanced, Turn limit (6), pass at both sizes. The text reads "The most model turns one task may take before it is stopped as failed. Leave it empty for the default of 100, or set a number from 10 to 500." The Turn limit field shows only for Cloud and machine agents. The Anthropic cloud agent's Advanced has only Model ("Use opus, sonnet or haiku.").
5. Agent header (7, 10, 12), pass at both sizes. The badges read "Runs on Cloud", "Runs on Anthropic cloud" and "Runs on my computer: Dom laptop".
6. Map inspector (16), pass at both sizes. The lines read "Agent · Runs on my computer: Dom laptop", "Agent · Runs on Cloud" and "Agent · Runs on Anthropic cloud". At phone width the line is cut off visually ("Runs on my computer: D…"), but the full text is in the DOM.
7. Runs on card (7, 10, 12), pass at both sizes.
   - Anthropic cloud: "Anthropic cloud / Simplest. Has its own sandbox." The card has no "Managed Agents".
   - Cloud: "Cloud / Always on, lowest cost for many small jobs."
   - Machine: "My computer: Dom laptop / Online / Claude Code on that machine. Sees local files."
8. Move agent dialog (8, 9), pass at both sizes.
   - Cost line: "Open conversations start fresh, because the agent will run somewhere that does not have their context. Files in the agent's sandbox do not move."
   - Cloud note (Anthropic cloud agent, target Cloud): "A conversation that ran on Cloud before may pick up there, without what happened since."
   - Model notice (Cloud agent on GLM-5.3): "This option runs Anthropic models only, and the current model is not one."
   - Machine target: "The agent's computer is detached."
   - The targets read Cloud, Anthropic cloud and My computer. No visible text says "runtime".
9. Secrets notes (11), pass at both sizes. The notes include "Anthropic cloud agents receive env secrets as placeholders that Anthropic swaps for the real value in outgoing requests." and "Proxy secrets reach agents on your computer and in Anthropic's cloud through the relay at /api/egress/<host>/<path>."
10. Settings, Model providers (14), pass at both sizes. The description starts "Cloud agents and Anthropic cloud agents both run on your workspace's own Anthropic API key."
11. Map cards (15), pass at both sizes. The cards read "0 tasks · My computer", "0 tasks · Cloud" and "0 tasks · Anthropic cloud". "Cloudflare" and "Our machine" do not appear.

## Console and network

- Desktop pass: the console showed one 404 and one 400. The 400 came from my dummy-key save on Home, which the server rejected as intended. The 404 came during login and Home, most likely favicon.ico. A clean desktop recheck of every flow page (console cleared, then each page loaded, then resource timing checked for status 400 or higher) found no errors and no failed requests.
- Phone pass: no console errors, no page errors, no requests with status 400 or higher.
- The vite log shows no server errors, only a TanStack Router notFound warning from the 404.
- agent-browser's network log captured nothing, so I checked failed requests with `performance.getEntriesByType(...).responseStatus` on each page.

## Observations (outside the intended results)

- The secrets notes still start two lines with "Isolate agents" and one with "Machine agents" ("Machine agents receive env secrets as environment variables of Claude Code."). The brief did not list these lines.
- The Cloud agent's form note starts "Runs in the cloud, not on one of your machines." This is fine, just not in the list.
