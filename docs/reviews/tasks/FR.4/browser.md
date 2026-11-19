# FR.4 browser verification (second pass)

Head d7bd2bad. Dev server on port 3218 from a clean `.wrangler`, signed in through `/api/dev-login`, agent-browser session `fr4-verify2`, headless Chromium at 1280x800 and 390x844.

## One thing I had to do
A clean workspace has no runtime (no Anthropic key, no machine). The review screen then shows "No runtime is available" and a blocking gap "Where it runs", so Create agent is disabled with "Decide first: Where it runs". This is the existing gap rule, not the key fix. To get past it I inserted one offline machine row ("verify box") into the local D1 with `wrangler d1 execute --local` (the Enrol a machine dialog only makes an enrol code, not a machine row). After picking "My computer: verify box (offline)" in Runs on, Create agent opened, with no Anthropic key set. The Run the dry run button stayed disabled, with the note "A dry run needs an Anthropic API key in Settings. You can still create the agent without one."

## Desktop (1280x800)
1. /agents/new: gallery "Start from a template" above the describe box, 8 cards, each name plus one line. `desktop-1.png`. Pass.
2. Click Inbox triage: draft loads with name "Inbox triage", address inbox-triage, Does text, voice Brief, "What the builder did" list (10 steps) and DryRunPanel. Gallery gone. No model call: the requests were `agentBuilder.fromTemplate` only, no `agentBuilder.draft`. No key needed. `desktop-2.png`. Pass.
3. Before choosing where it runs: Create disabled, gap shown (`desktop-3.png` shows the draft with the machine chosen, Create open, dry-run note). Create agent (Weekly report, second run; Inbox triage on the first run) lands on /agents/<id> showing the template name, runs on "My computer: verify box". `desktop-4.png`. Pass.
4. Back on /agents/new: "Import from a file" chip present, describe box took "typing works". `desktop-5.png`. Pass.
5. After a template click the gallery is hidden. Discard leaves /agents/new and lands on the /agents list (`desktop-6.png`); reopening /agents/new shows the gallery again. Pass (Discard goes to the list, not back to an empty builder; judged sensible).

## Phone (390x844)
1. Gallery shows 8 cards stacked in one column, name plus one line each, no horizontal scroll (scrollWidth 390). `phone-1.png`, full page `phone-2.png`. Pass.
2. Click Support first reply: draft, builder steps, review card and dry run panel stacked below the describe box, gallery hidden. `phone-3.png`. Pass. Minor: the Address input is narrow and clips "support-first-re" visually (value is full). Cosmetic, pre-existing layout.
3. Choose the machine, Create agent open with the same dry-run note (`phone-4.png`), Create lands on /agents/<id> titled "Support first reply" (`phone-5.png`). Pass.
4. /agents/new again: Import chip present, describe box takes typing, gallery visible, no horizontal scroll. `phone-6.png`. Pass.
5. Click Invoice filing: gallery hidden. Discard goes to /agents. `phone-7.png`. Pass.

## Console and network
Console at both sizes: only `[debug] [vite] connecting/connected`, the React DevTools info line and the Clerk "development keys" warning. All environmental. No page errors, no unhandled rejections (checked with window error listeners). No console errors from the app.

Network: agent-browser's request log has no statuses, so I wrapped `fetch` in the page and logged every call through template click, Create and landing at both sizes. Every `/api/trpc/*` call returned 200: fromTemplate, checkAddress, saveDraft, create, agents.list, agentBuilder.catalog, agents.get bundle, dictation.status, qa.openCount, artifacts.pins, desk.rail. No 4xx, 5xx or network failures. The vite dev log shows no errors beyond the Clerk warning. Clerk dev-instance script and API requests loaded (not status-checked, cross-origin); Vite HMR and the TanStack devtools console pipe are environmental. The floating palm-tree widget in screenshots is a dev overlay, not the app.

## Verdict
PASS. Every flow works at both sizes, no app console errors, no failed requests. Caveat above: on a workspace with no runtime at all, Create stays blocked by the Where it runs gap, which is existing behaviour and needs a machine or key to clear.
