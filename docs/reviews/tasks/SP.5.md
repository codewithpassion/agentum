# SP.5 review

## Verdict

Round 1, commit b84063cb: must-fix. The findings doc said both boundary runs (Sunday 23:40 and Monday 00:20 in Sydney) fall on the other side of the week line in UTC. Only the Monday run does.
Round 2, commit 9959fce7: clean. No must-fix findings.

Browser proof: two fresh verifiers. The first (round 1) failed on two points that came from the brief, not the code. I had expected the Home cards to read `$1.05` and `$0.55`, and I had not listed the second 409 that Dream now logs on a paused agent. Its report is `docs/reviews/tasks/SP.5/browser-round1.md`. The second verifier passed every flow at 1280x800 and 390x844 with only the known console errors: `docs/reviews/tasks/SP.5/browser.md`.

## What it does

The task is a walkthrough, so the code is a seed script and its test. `scripts/dev/seed-spend.ts` seeds two fake-runtime agents, 17 runs and 4 dream runs (one a team dream) with known costs, sets the workspace timezone to Australia/Sydney, and writes an active mailbox row for the first agent without calling Cloudflare. Mail replays through the dev server's `/cdn-cgi/handler/email`. `docs/reviews/SP-e2e.md` holds the hand-sum table, the pause and resume results, five proposed tasks (SP.6 to SP.10) and the hand-sum SQL. No product code changed.

## Nits left

- `seed-spend.ts` uses the wall clock. Run before Monday 01:10 Sydney time and this week's rows lie in the future. The header says so.
- The hand-sum SQL has no workspace filter and assumes UTC+11.
- The comment on `ensureMailbox` names the source function as `provision`, not `services.mail.provision`.
- Cosmetic, in other lanes: the mail sheet says "1 messages" and shows "Sent" twice, and the Spend chart's workspace-limit label overlaps the This week bar at phone width.

## Beyond the scope

The proposed tasks in `docs/reviews/SP-e2e.md`:

- SP.6, a dream that ends over a cap pauses its agent (`enforceCap` is not called from the dream; the team part follows TX.2).
- SP.7, the page and the cap round the week once, not each agent-day.
- SP.8, the pause card says what Resume does when the agent is still over its limit.
- SP.9, a cap pause lifts on Monday (a question for Dom first).
- SP.10, the Home card reads the Spend page's week.

Also: TX.2 must keep a team dream in the page total and the workspace cap, and its merge should be followed by a rerun of this walkthrough.

## Steps for Dom

Decide whether a cap pause should lift itself on Monday (SP.9). Nothing needs his accounts or dashboards.
