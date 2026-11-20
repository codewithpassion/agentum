# FR.3 browser verification (fr3-verify), head d89ee918

Dev server on port 5199, fresh local D1, dev login. System Chrome crashed in this sandbox, so the Playwright headless shell (chromium 1248) was used. Desktop 1280x800, phone 390x844.

## Flow 1 Fresh empty Home (first run)

Desktop (desktop-1.png, desktop-1b.png full page, desktop-2.png /desk): the guide shows. Step 1 has the one-line explanation (own Anthropic account, billed by Anthropic) and the Anthropic key form. Step 2 shows eight template cards, a "Or describe the job" box and "Continue to the builder", disabled, with the hint "Add your AI account above to draft from a description. Templates work without one." The left rail says "Nothing needs you" with no setup rows. /desk shows "Nothing needs you", no old setup pane. Pass.

Phone (phone-1.png, phone-2.png): same guide, stacked; no setup rows in the nav; /desk shows "Nothing needs you". Pass.

## First run, flows 2 to 4 (superseded)

With a fake key the app rejected it (400, live Anthropic check) and no runtime was offered, so flows 2 to 4 were blocked. See the re-run below.

## Re-run with the dev key (flows 2 to 4)

The dispatcher asked for the re-run with the dev Anthropic key from `apps/web/.env.local`. It was read into a shell variable, typed into the masked field, and never printed or written down. It went only into the local dev DB. Local state was wiped (`.wrangler/state`, migrations re-applied) before each size. Screenshots show only the masked field.

### Flow 2 Description survives adding the key
- Desktop (desktop-6.png after the save, desktop-7.png after Continue): typed "Summarise my Monday emails into five bullet points" in step 2, saved the key in step 1. Step 1 became the Done row ("Your AI account is added", Manage keys link), the description was still in the box, Continue was enabled. Continue opened /agents/new with the same text in the "What should it do?" box. Pass.
- Phone (phone-5.png, phone-6.png): identical. Pass.

### Flow 3 Template path to a created agent, no Settings
- Desktop (desktop-8.png runtime chosen, desktop-9.png the new agent page): Inbox triage template at /agents/new?template=inbox_triage. With the key set the catalog offers two runtime buttons, "Anthropic cloud" and "Cloud" (shown under Runs on as Anthropic cloud). Picked "Anthropic cloud", pressed Create agent (no dry run), landed on /agents/<id>. Settings never opened. Pass.
- Phone (phone-7.png): Meeting follow-up template at /agents/new?template=meeting_follow_up, same steps, landed on /agents/<id>. Pass.

### Flow 4 Roster wall
- Desktop (desktop-10.png): Home shows the agent card plus the dashed "New agent" and "Start from a template" cards, no guide. Pass.
- Phone (phone-8.png): same. /desk still shows only "Nothing needs you". Pass.

## Console and network (re-run)
No console errors during flows 2 to 4 at either size, no 4xx or 5xx on the flow requests. Key save succeeded (live Anthropic check passed). The only 400s in the whole verification are the ones from the first run: the fake-key rejection and the Clerk dev-login redemption noted above, outside the feature.

## Verdict
PASS. Every flow works at both sizes: the guide, the Done row, the surviving description, Continue into the builder, the template path with agent creation, the roster wall, and no setup rows in the rail, phone nav or /desk. Earlier first-run results (flow 1, template loading) still apply; the first-run fake-key failures are superseded by this re-run. Caveat: the dev-login 400 is a Clerk redemption response, not from the feature.
