# SL.11 browser verification

Verifier: independent, did not build the feature. Worktree `harbourmaster-wt/SL.11`, branch task/SL.11-linking-needs-a-person-who-is-in-the-cha, commit 196f3ddd. Real app (`vite dev` on 5191, local D1) against the local fake Slack on 5199, signed in through `/api/dev-login`, seeded with `scripts/dev/seed-slack-room.ts` (team "Launch", id fecace2e-...). Desktop 1280x800, then phone 390x844 after a re-seed. Headless Chromium through agent-browser, session `sl11-verify`. No source changed, no commit, no Clerk change.

## Verdict

FAIL, for one reason only: the non-admin behaviour cannot be exercised in the browser. Everything that could be exercised works at both sizes with no console error and no failed request.

The dev user is an admin. Clerk reports one membership, "Dev Workspace", role `org:admin` (read from `window.Clerk.user.organizationMemberships` in the page). The server sets `isAdmin` only from the Clerk session's `orgRole === "org:admin"` (`packages/services/src/workspaces.ts` `sessionPrincipal`, called from `apps/web/src/server/trpc/build-context.ts`). There is no dev env var, seed option or local D1 row that changes it. `create-dev-user.ts` makes the dev user the creator, and so the admin, of its organisation. Making the dev user a non-admin, or signing in as a second member, needs a Clerk change, which this check may not make. So the non-admin picker filter (only #sl5-room), the refusal of a channel the person is not in, and the "Your Slack account is not linked" message are covered only by `packages/services/src/teams.test.ts` and `apps/web/src/server/slack-room-flow.test.ts`. I did not see them in a browser.

## Results

| Flow | Desktop | Phone |
|---|---|---|
| A admin: picker lists all three, private marked, sentence shown, linking works | pass | pass |
| A non-admin: only #sl5-room, no private, sentence, link | not exercisable (fail) | not exercisable (fail) |
| B non-admin: "not linked" message after deleting the identity link | not exercisable (fail) | not exercisable (fail) |
| B admin: picker still loads with no identity link | pass | pass |
| C unlink returns to the picker | pass | pass |

Phone page width stayed at 390 (`document.documentElement.scrollWidth`), so there was no horizontal overflow.

## Flow A, admin

Steps: opened `/teams/<id>`, read the "Slack channel" select, then linked and unlinked each channel in turn: #sl5-outside, #sl5-secret, #sl5-room.

Saw: the select lists "Pick a channel", "#sl5-outside", "#sl5-room", "#sl5-secret (private)". Under the "Link channel" button: "Only an admin can link a private channel, because its messages would land in a room every workspace member can read." (desktop-1, phone-1; the native select is closed in the screenshot, and the options come from the accessibility snapshot.) Linking #sl5-outside, which Dev Person is not in on Slack, showed "Linked to #sl5-outside" (desktop-2, phone-2), as an admin may. Linking the private #sl5-secret showed "Linked to #sl5-secret" (desktop-4, phone-4). Linking #sl5-room showed "Linked to #sl5-room" (desktop-5, phone-5). Each linked state also listed Di with `/invite @di`, because Di's app is not in the fake channels. That is expected.

## Flow B

Steps: unlinked, ran `wrangler d1 execute DB --local --command "DELETE FROM identity_links"` in apps/web (1 row before), reloaded the team page.

Saw: as admin the picker still loads with all three channels and the private sentence (desktop-7, phone-7). This confirms that admins skip the identity check. The non-admin message could not be shown, for the reason given above. The seed was re-run afterwards to restore the link.

## Flow C, unlink

Steps: pressed "Unlink" while linked (to #sl5-outside, then to #sl5-room).

Saw: the "Slack channel" select with all three options and a "Link channel" button came back each time (desktop-3, desktop-6, phone-3, phone-6).

## Errors, console and network

- Console, desktop and phone: no errors. The only warnings are Clerk's "loaded with development keys" lines (tmp/SL.11/console-desktop.txt, console-phone.txt). `agent-browser errors` printed nothing at either size.
- Network: same-origin resource timing showed no response with status >= 400. The phone request log (tmp/SL.11/net-phone.txt) shows the expected `teams.slack.status`, `teams.slack.channels`, `teams.slack.link` and `teams.slack.unlink` calls. Every link and unlink took effect in the UI. The desktop request log was not captured, because recording started only with the phone pass. For the desktop pass I relied on the console, the resource timing and the server logs.
- vite.log and fake.log contain no error lines.

## Notes (not failures)

1. The private-channel sentence shows to admins too, and an admin can link the private channel. The sentence explains why a non-admin cannot, so this is consistent.
2. To verify the non-admin path in a browser, the controller could add a second Clerk member (role `org:member`) to the dev organisation, or give the dev login a member mode. Either needs a Clerk change.

## Round 2: non-admin (org:member)

Verifier: independent, did not build the feature. Same worktree and branch, same setup as round 1 (`vite dev` on 5191, local D1, fake Slack on 5199), agent-browser session `sl11-mem2`, headless Chromium. Desktop 1280x800, then phone 390x844. No source changed, no commit, no Clerk user added.

### Setup

- Signed in as the existing plain member `dev+member@harbouredgeintelligence.ai` with `bun run agent-login --email dev+member@harbouredgeintelligence.ai --base-url http://localhost:5191 --redirect /teams`. Starting vite with `DEV_LOGIN_EMAIL=<member>` did not work: `/api/dev-login` still signed in the admin dev user, because `.env.local` wins over the process env. So agent-login it was.
- `window.Clerk.user.organizationMemberships` in the page: one membership, "Dev Workspace", role `org:member`, user `user_3MLzrHwgcyG5ABwkRhvqdF8hoxg`.
- Ran `bun scripts/dev/seed-slack-room.ts --clerk-user user_3MLzrHwgcyG5ABwkRhvqdF8hoxg`. It moved the identity link (`slack`, `U0DEVPERSON`, `T0SL5LOCAL`) to the member and added the member to the "Launch" team. The seed does not change the owner of a team that already exists, so I ran `UPDATE teams SET owner_user_id='user_3MLzrHwgcyG5ABwkRhvqdF8hoxg' WHERE slug='launch'` on the local D1. The admin dev user stays a team member from round 1.
- To show the refusal in the page, I removed Dev Person from `#sl5-room` with the fake's `POST /_membership {"botUserId":"U0DEVPERSON","member":false}` after the page had loaded, then put Dev Person back.

### Results

| Flow | Desktop | Phone |
|---|---|---|
| 1 Picker lists only #sl5-room, no #sl5-outside, no private channel; private-channel sentence shown | pass (member-desktop-1) | pass (member-phone-1) |
| 1 Link #sl5-room shows "Linked to #sl5-room" | pass (member-desktop-2) | pass (member-phone-2) |
| 1 Unlink returns the picker | pass (member-desktop-3) | pass (member-phone-3) |
| 2 `teams.slack.link` for C0SL5OUTSIDE refused | pass, 400 | pass, 400 |
| 2 `teams.slack.link` for G0SL5SECRET refused | pass, 400 | pass, 400 |
| 2 Refusal in the page after Dev Person left #sl5-room | pass (member-desktop-4) | pass (member-phone-4) |
| 2 After reload the picker no longer lists #sl5-room | pass (member-desktop-5) | pass (member-phone-5) |
| 3 No identity link: "not linked" message replaces the picker | pass (member-desktop-6) | pass (member-phone-6) |

Phone page width stayed at 390 (`document.documentElement.scrollWidth`).

### Flow 1, picker, link and unlink

Steps: opened `/teams/fecace2e-51ce-441c-a96c-a687ea66436b`, read the options of the "Slack channel" select, picked #sl5-room, pressed "Link channel", then "Unlink".

Saw: the select holds only "Pick a channel" and "#sl5-room". Under the button: "Only an admin can link a private channel, because its messages would land in a room every workspace member can read." Linking showed "Linked to #sl5-room" and the `/invite @di` line for Di (Di's app is not in the fake channel, as in round 1). Unlink brought back the select with the same two options.

### Flow 2, refusal

Steps: from the page, `fetch("/api/trpc/teams.slack.link", {method: "POST", body: {channelId, slackTeamId: "T0SL5LOCAL", teamId}})` with the member's session, once per channel. Then I reloaded the page with #sl5-room in the picker, removed Dev Person from #sl5-room in the fake, picked #sl5-room and pressed "Link channel". Then I reloaded once more and put Dev Person back.

Saw:
- C0SL5OUTSIDE: HTTP 400 `BAD_REQUEST`, "Slack does not show you in that channel. Join it in Slack and try again, or ask an admin to link it."
- G0SL5SECRET: HTTP 400 `BAD_REQUEST`, "Only an admin can link a private channel, because a private channel's messages would land in a room every workspace member can read." Its wording differs slightly from the page sentence ("a private channel's messages" against "its messages"). Both say the same thing.
- In the page, red text under the button: "Slack does not show you in that channel. Join it in Slack and try again, or ask an admin to link it." The team stayed unlinked.
- After the reload: "No channel to link. You can link a channel you are in on Slack when the lead's Slack app is in it too. Join or invite the app in Slack first." The private-channel sentence still shows.

### Flow 3, not linked

Steps: `bunx wrangler d1 execute DB --local --command "DELETE FROM identity_links"` in apps/web, then reloaded the team page. Re-ran the seed afterwards to restore the link.

Saw: in place of the picker, in red: "Your Slack account is not linked to Agentum. Mention one of this team's agents in Slack so it can link you, then try again. An admin can link the channel without this." The page has no Slack channel select and no Link button. The other selects (Add a person, Lead) are still there.

### Errors, console and network

- Console, each size: four "Failed to load resource: the server responded with a status of 400" lines and Clerk's "development keys" warnings. Nothing else at error level. `agent-browser errors` printed nothing. Logs are in tmp/SL.11/r2-console-desktop.txt and r2-console-phone.txt.
- The four 400s are all expected refusals: the two hand-made `teams.slack.link` calls (C0SL5OUTSIDE, G0SL5SECRET), the in-page `teams.slack.link` refused for #sl5-room, and the `teams.slack.channels` query while the member has no identity link. That query returns 400 with the "not linked" message by design, and the page shows that message. I confirmed this with a direct GET of the same query (400, same text) and with the request log (tmp/SL.11/r2-net-phone.txt).
- No other same-origin response had a status of 400 or more (resource timing). r2-vite.log and r2-fake.log hold no error lines, only TanStack Router's notFoundComponent warning at startup.

### Verdict

PASS. Every non-admin flow works at both sizes. The only console errors are the expected 400s of deliberate refusals.

Notes, not failures:
1. The "not linked" state is delivered as a 400 on a query, so a member with no Slack link gets one console error each time the team page loads. It works, but a plain result (for example `{ linked: false }`) would keep the console clean.
2. The private-channel server message and the page sentence word the same rule slightly differently.
