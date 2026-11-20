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
