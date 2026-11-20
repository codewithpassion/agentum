# JB.6 browser verification

Verifier: browser run on 20 Nov 2026 against `bunx vite dev --port 51731` in the JB.6 worktree, agent-browser session `jb6-verify`, Chromium headless shell. Local D1 migrated (0058 applied), fake runtime agent `fake-echo` (id 01M7VNYV8QEFFPMMFEN0REJAF4) from `scripts/dev/seed-fake-agent.ts`. Viewports 1280x800 (desktop) and 390x844 (phone). The browser's own zone is Australia/Sydney (wall clock 4:13 pm at the first run). Screenshots are in this folder.

## Setup notes

- The browser session arrived already signed in as the dev user but without an active organisation, so `/home` bounced to `/login` and the seed script found no workspace. Opening `/api/dev-login` redeemed a Clerk ticket, landed on `/home` with the "Dev Workspace" workspace, and the seed then worked. The "Dev login (local only)" link is hidden when signed in, so I hit its target URL directly.
- The workspace timezone defaulted to UTC. After the first run I set it to Australia/Sydney in Settings, Timezone (saved) to check the clock time against a known zone.
- "Run now" on the agent page opens a "New conversation" dialog ("What should it do?"). I typed a prompt and pressed "Start conversation"; the fake runtime finished the run on its own within seconds. Job drafting ("Draft job" on the Jobs tab) needs an Anthropic key, so I could not create a routine through the UI. For the routine variant I inserted one `triggers` row (kind routine, cron `0 9 * * 1-5`, timezone Australia/Sydney) into the local dev database with sqlite3, then reloaded.

## Flow A: before any run

Steps: signed in, seeded agent, opened `/home`.

- Desktop: card reads "Idle" and has no "Done" text (`desktop-1.png`).
- Phone: same, "Idle" (`phone-1.png`). Layout intact.

## Flow B: run finished, then home

Steps: agent page, "Run now", prompt "Draft the weekly status note", "Start conversation". The thread page showed "Done, Fake echo, 05:13, took 0s". Then `/home`.

Without a routine, workspace timezone UTC:
- Phone: "Done 5:13 am: Draft the weekly status note" on one line, nothing cut (`phone-2.png`).
- Desktop: "Done 5:13 am: Draft the weekly status note", wraps to two lines, nothing cut (`desktop-2.png`).
- 5:13 am is correct for UTC (4:13 pm Sydney is 05:13 UTC, and the thread page shows the same 05:13). Sidebar changed from "0 done today" to "1 done today".

Without a routine, workspace timezone Australia/Sydney:
- Both sizes: "Done 4:13 pm: Draft the weekly status note", no "Next run" suffix (`desktop-3.png`, `phone-3.png`). Matches the real local clock time of the run.

With a routine (cron 0 9 * * 1-5, Sydney):
- Phone: "Done 4:13 pm: Draft the weekly status note. Next run 23 Nov, 9:00 am", two lines, fully visible (`phone-4.png`).
- Desktop: same text on three lines, fully visible (`desktop-4.png`).
- 23 Nov is the next weekday 9 am after Friday 20 Nov. Correct.

Long title (second run from the phone, prompt "Reconcile the quarterly supplier invoices against the purchase orders and flag every mismatch for the finance team before the end of month close", routine still present):
- Phone: "Done 4:16 pm: Reconcile the quarterly supplier invoices against the purchase orders and fla.... Next run 23 Nov, 9:00 am", three lines, all visible, no overflow or layout break (`phone-5.png`).
- Desktop: same text on four lines, all visible (`desktop-5.png`).
- The two-line clamp does not take effect in the browser: the status span has `line-clamp-2 block`, but three lines render in full at both sizes, so nothing is cut off. The title is shortened to "fla..." by the service (not by CSS), and the appended period gives "fla....". Both are cosmetic and outside the "Done" wording itself. The same `line-clamp-2 block` pairing exists on the job line in `agent-card.tsx`, not changed by this task.

## Flow C: reload

I reloaded `/home` many times at both sizes (after each run and in the console/network pass). The card shows the same "Done ..." line each time, no flicker to "Idle", no layout break.

## Console and network

- Over the whole session, console errors came from two places outside the JB.6 flows:
  1. `Failed to load resource: 400 ()` during the `/api/dev-login` ticket redemption (reproduced on a second dev login).
  2. `Failed to load resource: 400 (Bad Request)` when I clicked "Draft job" on the Jobs tab, where the page itself says "This workspace has no Anthropic API key" (reproduced).
- With the console cleared, `/home` loaded and reloaded at both sizes produced no console errors. The only other messages were the Clerk development-keys warning, a React DevTools info line and a WebGL software-fallback warning.
- The dev server log shows no server errors. agent-browser's request log has no status codes, so I attributed the failed requests through the console errors above, not a status list.

## Verdict

pass for the feature. The card line reads "Done <clock time>: <run title>" with ". Next run ..." only when a routine exists, the time follows the workspace timezone, and the line is readable at 1280x800 and 390x844 with no layout break.

Caveats for the controller: the two 400 console errors above come from dev login and from an unconfigured Anthropic key (the Jobs tab draft action), not from the card. If the "no console errors" bar covers the whole session, count them as expected environment errors. The 24-hour fall-back to "Idle" was not exercised in the browser (no way to age a run), and the routine was seeded by a database insert, not through the UI.
