# SP.10 browser verification

Verdict: **pass**. All four flows work at 1280x800 and 390x844. Fake second's Home card reads "$0.55 this week" with no limit, the same figure as the Spend page. With a $5 limit it reads "$0.55 of $5 this week", and it goes back to "$0.55 this week" once the limit is removed. Fake echo's card and both rows of the Agents table's Cost this week column match the Spend page too. No page had a console error, a page error or a failed request.

## Setup

- Worktree `task/SP.10-the-home-card-shows-the-spend-page-s-wee` at commit 74f2e07d.
- `bunx wrangler d1 migrations apply DB --local` applied the migrations up to 0060. Then `bunx vite dev --port 3101` ran from `apps/web`.
- The headless browser already had a session cookie from an earlier sign-in as dev@rockyshoreslabs.io, so `/login` showed "Welcome back" and not the "Dev login (local only)" link. I opened `GET /api/dev-login`, the route that link calls. It redirected through `/dev-login?token=…` to `/home` with a fresh session, and that made "Dev Workspace" in this worktree's local D1.
- `bun scripts/dev/seed-spend.ts` from the worktree root inserted 17 runs and 4 dream runs into that database and set the timezone to Australia/Sydney. Its sessions belong to the user `seed-spend`, not to the dev user. That is the case the task fixes: the viewer cannot see the sessions behind the spend.
- To check for errors I read the browser console after each page. Chrome logs every 4xx or 5xx response and every failed load there as `[error] Failed to load resource`. I confirmed that with a deliberate 404 before the flows, then cleared it. I also read the page-error log and the Performance API response statuses. The only console message was Clerk's development-keys warning. favicon.ico produced no message.
- The Spend page has no per-agent limit control of its own. Its Limit column only shows the value. The "Set a limit" button sets the workspace limit and links to `/settings/spend`. For flow D I clicked "Fake second" in the Spend table. That opens the agent's room, and I set the limit under Settings > Weekly spend limit.

## Flow A, Spend page

### Desktop 1280x800 (`desktop-1.png`)
Opened `/spend`. The This week column read Fake echo $1.05, Fake second $0.55 and Team dreams $0.60, with a total of $2.20. The chart's this-week bar read $2.20, and the Limit column read None for both agents. These match `docs/reviews/SP-e2e.md`. No console errors and no failed requests.

### Phone 390x844 (`phone-1.png`, `phone-1b.png`)
The figures were the same as on desktop. The table scrolls sideways inside its own container, and the page does not scroll sideways (document width 390). `phone-1b.png` shows the table scrolled to the This week and Limit columns. No console errors and no failed requests.

## Flow B, Home cards, no limit

### Desktop (`desktop-2.png`)
Opened `/home`. Fake echo's card read "$1.05 this week" and Fake second's card read "$0.55 this week". Both match the Spend page. No console errors and no failed requests.

### Phone (`phone-2.png`)
The cards were stacked, with the same text: "$1.05 this week" and "$0.55 this week". No console errors and no failed requests.

## Flow C, Agents table

### Desktop (`desktop-3.png`)
Opened `/agents`. The Cost this week column read Fake echo $1.05 and Fake second $0.55. Both match the Spend page. No console errors and no failed requests.

### Phone (`phone-3.png`, `phone-3b.png`)
The figures were the same, $1.05 and $0.55. Cost this week is the last column, so it sits off-screen until the table is scrolled sideways inside its container (`phone-3b.png`). The page does not scroll sideways. No console errors and no failed requests.

## Flow D, set and remove a weekly limit on Fake second

### Desktop (`desktop-4a.png`, `desktop-4.png`, `desktop-5.png`)
1. From `/spend` I clicked "Fake second", opened Settings, entered 5 under Weekly limit and clicked Save. The form showed "Saved." (`desktop-4a.png`).
2. I reloaded `/home`. Fake second's card read "$0.55 of $5 this week", and Fake echo's still read "$1.05 this week" (`desktop-4.png`). `/spend` then showed $5 in the Limit column.
3. In the same Settings form I cleared the Weekly limit field and clicked Save. I reloaded `/home`, and Fake second's card read "$0.55 this week" again (`desktop-5.png`). The Limit column on `/spend` read None.

No console errors and no failed requests at any step.

### Phone (`phone-4a.png`, `phone-4.png`, `phone-5.png`)
I repeated the same steps at 390x844, again starting from the Spend table's "Fake second" link. With the $5 limit the card read "$0.55 of $5 this week" (`phone-4.png`). After I cleared the limit it read "$0.55 this week" (`phone-5.png`), and the Spend page showed Limit None. In this run I clicked Save once more while the field still held 5, and that save did not change the limit. No console errors and no failed requests.

## End state

Fake second has no weekly limit, as before the walkthrough. The seeded rows remain in this worktree's local D1.
