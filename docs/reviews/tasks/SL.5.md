# SL.5 review: Slack link end to end

A fake Slack, an in-process end-to-end test, a local browser walkthrough and the staging steps. Haiku workers wrote the guest rendering (`room-logic.ts`, `room-post.tsx`), the room search (`slack/room-search.ts`) and the seed script (`scripts/dev/seed-slack-room.ts`) with their tests. The dispatcher wrote the fake Slack, the HTTP fake, the dev seam, the e2e test and the docs. Reviewed by Opus. The browser was driven by a fresh verifier: `docs/reviews/tasks/SL.5/browser.md`.

## Verdict

Round 1, commit df613d18: one must-fix. `slack_search` found the team through the channel's current link, so after an unlink and a relink to another team, agents of the new team could search the old team's room posts. Fixed in 3f37bff9 by requiring the topic's team to be the linked team.

Round 2, commit 3f37bff9 (the fix commit only): clean. The reviewer rebuilt the case with the real flow and saw it fail on the old code and pass on the new.

Browser proof: pass at 1280x800 and 390x844 for flows 1 to 6, no console error, no failed request.

## What the task found

The SL.2 log note asked two questions. `slack_history` still finds linked-channel messages, because it reads Slack live. `slack_search` did not, and now does. Guest posts showed as "Teammate" with the prefix in the body, and now show the guest's name, a "Slack guest" tag and the message alone. Details are in `docs/reviews/SL-e2e.md`.

## Decisions the task left open

- "The fake gateway" did not exist as something the dev server could talk to, only as stubs in tests. The fake is `packages/services/src/slack/fake-slack.ts`. A dev build reaches it through `VITE_FAKE_SLACK_URL`, read in `dev-slack-fetch.ts` and wired in `compose.ts` (one line). It is off unless the build is a dev build and the variable is set.
- Room search follows the same rule as the room: an agent sees the room's messages only when it is on the linked team (member or lead), the topic is open to the whole team, and the topic belongs to the team the channel is linked to now. After a relink, the old team's agents lose search over their old room posts. If the channel goes back to them, the posts return.
- The approval card is covered by the in-process test only. The fake runtime never asks for approval, so SL.6 is proposed.

## Nits left

- `room-search.ts` keeps its own copy of `escapeLike`, because `messages.ts` does not export it.
- `scripts/dev/fake-slack.ts` binds `localhost`, which Bun resolves to 127.0.0.1. The verifier ran with `VITE_FAKE_SLACK_URL=http://127.0.0.1:5199` for that reason.
- Vite inlines `import.meta.env`. A `VITE_FAKE_SLACK_URL` in `apps/web/.env.local` would put the URL string in a production bundle. It stays inert there.
- The old forum inbox components (`components/inbox/post-list.tsx`, `thread-panel.tsx`) have no route and nothing renders them. They would show a guest as "Teammate". I left them alone.
- The room's raw Slack markup, the topic list's missing "selected" style and the fake runtime quoting thread history (which wakes a quoted `@cy` and produces two extra echo replies) are not product faults.
- The first load after the seed can hit one `SQLITE_BUSY` on `desk.rail` when the seed script writes the database the dev server has open. It did not recur in any flow.

## Ideas beyond the scope

SL.6 to SL.9 in `docs/reviews/SL-e2e.md`: a fake runtime that asks for approval, a guest author kind, Slack markup both ways, and a sweep for lost room work.

## Steps for Dom

The staging walkthrough in `docs/reviews/SL-e2e.md` (fourteen steps, each with what to expect) is waiting on you. You need a Slack workspace where you can make apps, two agents with Slack apps made from this build's manifest, a third Slack account with no Agentum account, and a staging deploy of this branch. Steps 1, 2, 3 and 10 are the ones only real Slack can answer: whether Slack accepts the manifest and the interactivity URL, and whether the approval card lands in the thread.

## Checks

`bun run check`, `bun run test` and `bun run build` pass. The CI bundle grep found no `drizzle` in `apps/web/dist/client`.
