# SL.4 browser verification

Branch task/SL.4-slack-link-ui. `vite dev` on port 5187, Chromium headless via agent-browser (session sl4-verify), dev login through `/api/dev-login`. Desktop 1280x800, phone 390x844. Screenshots are in this folder: `desktop-<n>.png` and `phone-<n>.png` are the main shot of flow n, and letter suffixes are other states of the same flow.

## How it ran

- Local D1 migrated with `wrangler d1 migrations apply DB --local`. I seeded by SQL: three agents (Atlas lead, Borealis, Cove), teams `Slack Desk` (desktop), `Slack Phone` (phone) and `Slack Reader`, and `slack_apps` rows (installed, NULL bot token, Slack team `T0SL4`) for Atlas and Borealis only. Cove has no Slack app.
- The dev user is a Clerk org admin (`org_role` admin in its session token), so it can edit every team. See flow 5.
- agent-browser 0.14.0 bug: `network route --body` is accepted but ignored (the CLI sends `body`, the daemon reads `response`), so the mock never fires. I sent the same `route` command straight to the daemon socket with a `response` object (status 200, application/json). The mocks are therefore ordinary Playwright route fulfils. The Chromium process and the app are real.
- Request shape, read from `agent-browser network requests`: tRPC over `httpBatchLink` at `/api/trpc`, no superjson. Queries are `GET /api/trpc/teams.slack.<name>?batch=1&input=...`, the mutation is `POST /api/trpc/teams.slack.link?batch=1`. Stubs use the batched body `[{"result":{"data":...}}]`, and the error stub uses `[{"error":{"message":...,"code":-32600,"data":{"code":"BAD_REQUEST","httpStatus":400,"path":"teams.slack.link"}}}]`.

## What was stubbed, what was real

- `teams.slack.channels`: always stubbed (real call returns `no_token`, there is no Slack). Three channels: `#general`, `#ops-room`, `#leads-private` (private).
- `teams.slack.link`: stubbed (success in flow 2, refusal in flow 3). The `team_slack_links` row was inserted by SQL to match.
- `teams.slack.status`: real for the first "linked" shot of every flow 2 (no Slack call, NULL tokens: name falls back to the channel id, Atlas and Borealis show `/invite` lines, Cove shows "has no Slack app yet"). Stubbed where a channel name or a mix was needed: `2b` (Atlas in channel, Borealis not, Cove no app), `2c` (all in channel), room header with a name, and the reader shots (name `#general`; the stub lists Cove too, which is not a member of that team, so the page names Cove from the roster).
- `teams.slack.unlink`: real, deleted the row (confirmed `count(*) = 0` in D1).
- Room page status: real for "Slack linked" (no name from Slack) and for the unlinked case, stubbed for "Slack #ops-room".
- Everything else (team page, members, jobs, auth, dev login) is real.

## Flows

Desktop (D) and phone (P). Overflow is `scrollWidth/clientWidth` of the document, 1280/1280 and 390/390 on every page below.

1. Unlinked, owner. Steps: open the team, wait for the section. D (`desktop-1.png`) and P (`phone-1.png`): Slack section shows "Slack channel" select with options "Pick a channel", `#general`, `#ops-room`, `#leads-private (private)`, the help text and a dimmed "Link channel" button (disabled until a pick). P select is 358px wide, fits. After picking `#ops-room` the button is enabled (`desktop-2a.png`, `phone-2a.png`). PASS D and P.
2. Pick and Link. Steps: pick `#ops-room`, click Link channel (stub 200), the section refetches status (still unlinked, as expected from the stub), insert the link row, reload. D (`desktop-2.png`, `2b`, `2c`) and P (`phone-2.png`, `2b`, `2c`): real status reads "Linked to C0OPS", Unlink button, "These agents' Slack apps are not in the channel yet. Paste each line in the channel in Slack:", Atlas `/invite @atlas`, Borealis `/invite @borealis`, Cove "has no Slack app yet". With the status stub: "Linked to #ops-room", Atlas (in channel) is not listed, Borealis `/invite @borealis`, Cove "has no Slack app yet". All-in-channel stub: "Every agent's Slack app is in the channel." PASS D and P.
3. Refused link. Steps: stub link with the tRPC error, pick `#leads-private`, click Link channel. D (`desktop-3.png`) and P (`phone-3.png`): "The lead's Slack app is not a member of that channel. Invite it in Slack first." appears as a red `role=alert` line under the picker, the picker keeps its value, Link stays enabled, a second pick works. No crash. PASS D and P.
4. Unlink (real). Steps: with a stored link, click Unlink. D (`desktop-4a.png` before, `desktop-4.png` after) and P (`phone-4a.png`, `phone-4.png`): POST `teams.slack.unlink` 200, then status and channels refetch, the section shows the picker again, D1 has no link row. PASS D and P.
5. Reader (re-run with a real non-admin member). PASS D and P. Setup: Clerk dev user `dev+sl4reader@harbouredgeintelligence.ai` created through the Clerk backend API and added to "Dev Workspace" as `org:member`, signed in with `agent-login` in a fresh session (`sl4-reader`). Seeded in local D1: `Slack Reader` (owner `user_other_person`, now unarchived) with a `team_slack_links` row (C0READ), `Slack Unlinked` (same owner, no row). Steps and results, same at 1280x800 and 390x844 (no horizontal overflow, 1280/1280 and 390/390):
   - 5r-a, linked, not owner (`desktop-5ra.png`, `phone-5ra.png`): the page says "Only an admin or the team's owner can change this team.", the Slack section reads "Linked to C0READ" (stored id, no Slack name offline), the missing-apps text and `/invite @atlas`, `/invite @borealis`. No select, no Link or Unlink button (DOM check: 0 selects, 0 buttons matching link).
   - 5r-b, unlinked, not owner (`desktop-5rb.png`, `phone-5rb.png`): "This team's room is not linked to a Slack channel.", no picker, no Link button, same banner.
   - 5r-c, owner, unlinked (`desktop-5rc.png`, `phone-5rc.png`): the member was set as `owner_user_id` of `Slack Phone` in D1. No "Only an admin" banner, the team is editable (Remove, Add, Save visible) and the Slack section is the editor. Channels was not stubbed: the real `teams.slack.channels` call answers 400 `no_token` (no Slack here), so the picker area shows "Slack would not list the channels (no_token)." instead of the select. This proves the section chose the editor branch, not the picker contents (flows 1 to 3 cover those).
   - 5r-d, owner, linked (`desktop-5rd.png`, `phone-5rd.png`): `Slack Desk` owned by the member with a link row: "Linked to C0OWN" and an Unlink button are shown.
   - Server check, signed in as the member on the non-owned team, in-page `fetch`: `POST /api/trpc/teams.slack.unlink?batch=1` with body `{"0":{"teamId":"TEAM_READER"}}` answered 403 FORBIDDEN "Not allowed: teams.write", and `POST teams.slack.link?batch=1` for `Slack Unlinked` with a full valid body answered 403 FORBIDDEN too. One earlier link call missed the `slackTeamId` field and got 400 (my malformed body, not an app fault). D1 afterwards still holds the `TEAM_READER` / `C0READ` link row and none for `Slack Unlinked`.
   - Reader loads only requested `teams.slack.status` (200), never `teams.slack.channels`. Editor loads also request channels (the 400 `no_token` above).
   - Console and network: no page errors. The only console errors are the three deliberate API calls (two 403, one 400) and the 400 `no_token` channels responses on the owner pages. Every other `/api/trpc` call was 200 (read with a fetch wrapper after a client-side navigation, since agent-browser's request log shows no status). No failed requests besides these.
   - The earlier attempt (archived team as a stand-in for a reader) is superseded by this run.
   - Cleanup: the Clerk reader user and its membership were deleted, D1 ownership of `Slack Phone` and `Slack Desk` restored and the `C0OWN` row removed, browser closed, dev server stopped.
   - Observation, not a failure: the reader view still shows "Link the team's room to one Slack channel." under the Slack heading, which is editor wording shown to readers.
6. Room header. Steps: open `/teams/<id>/room`. D (`desktop-6a.png` unlinked, `desktop-6b.png` linked with no Slack name, `desktop-6.png` named) and P (`phone-6a.png`, `phone-6b.png`, `phone-6.png`): unlinked shows nothing under "Team room" (desktop) or the title (phone). Linked shows "Slack linked", and with a name "Slack #ops-room" under "Team room" on desktop and under the title on phone. PASS D and P.

Layout: no horizontal overflow at either size on the team page or room page. The Slack section stacks in the right column on desktop and in the single column on phone, text is readable, the code chip wraps cleanly, the other sections keep their spacing.

## Console and network

- No console errors and no page errors in any flow once the stubs were in place, apart from the items below.
- The first desktop load logged one HTTP 500 and one 400. The 500 was a local Miniflare D1 error ("Failed to get session commit token") inside `desk.rail`, a different tRPC call from Slack, not reproduced afterwards. The 400 was the real `teams.slack.channels` call answering `no_token` before I stubbed it, expected with no Slack.
- The refused link returns a stubbed `error` body, expected. Stubbed calls all answered 200.
- agent-browser's request log lists some requests several times and drops others, so for mutations I wrapped `fetch` in the page and read its log: link 200, unlink 200, each followed by a status 200 (and a channels 200 for the unlinked state).

## Verdict

PASS. Flows 1 to 6 work at both 1280x800 and 390x844. Flow 5 now ran with a real non-admin Clerk member: reader view is read-only (linked and unlinked), the owner gets the editor, and the server answers FORBIDDEN to the member's link and unlink calls with the row untouched. No console errors or failed requests other than the deliberate FORBIDDEN/400 calls and the expected `no_token` channels 400 (no Slack offline). Caveat: the owner's picker contents were not re-shown in this run (no stub), they were covered in flows 1 to 3.
