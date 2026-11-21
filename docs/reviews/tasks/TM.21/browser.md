PASS

# TM.21 browser verification (dbb29c38)

Setup: vite dev on port 3471, dev login, agent-browser session tm21-verify (Chromium from the Playwright cache, since the default headless shell was missing). Two teams created in the Teams UI with Dev User as member: "Archive Me" (archived later) and "Live Team". Desktop 1280x800, phone 390x844.

## Live room (before archiving)
Steps: Teams > New team "Archive Me" > Open room > New topic "Launch plan" > post "First post while live".
- Desktop (desktop-1.png): "New topic" button and the Message composer with Send are present. Post landed.
- Phone (phone-1.png, phone-2.png): composer is present; the Topics sheet shows "New topic" and the topic list.

## Archive
No archive button exists in the Teams UI. Archived through the app's tRPC endpoint from the signed-in browser: POST /api/trpc/teams.archive {teamId} returned 200 with archivedAt set.

## Archived room, desktop
- Reload /teams/<id>/room (desktop-2.png in the same state, desktop-3.png with the topic open): the topic "Launch plan" and its post are shown; "This team is archived. Its room is read-only." appears once in the sidebar under "Team room"; no New topic button, no composer, no Send, and no "You are not in ... so you can read this topic but not post." note.
- Seeded in the local D1 (sqlite insert: one agent, one agent post, one running discussion, since no agent exists to create them through the UI). desktop-4.png: member sees "Discussion round 1 of 3", "Stop discussion" and "Dismiss", with no composer and no not-in-team note.
- Clicked Dismiss: attention_cleared_at was set in the DB. Clicked Stop discussion: the row went to status "stopped" and the button disappeared (desktop-5.png). Dismiss stayed visible only because my seeded post was timestamped about a minute in the future; not an app fault.

## Archived room, phone
- phone-3.png: Topics sheet lists the topic. The archived line is not inside the sheet.
- phone-4.png: the archived line shows in the room header next to the "Topics" button, above the topic. No composer, no New topic, no not-in-team note. With a re-seeded waiting post and running discussion, "Discussion round 2 of 3", "Stop discussion" and "Dismiss" are shown. (Spec said "check it shows there too": it shows at phone size in the page header, not inside the sheet.)

## Server refusal
From the signed-in browser, against the archived team:
- POST /api/trpc/inbox.post {threadId, text} returned 403 FORBIDDEN "Not allowed: inbox.post". No row was written (checked in D1).
- POST /api/trpc/inbox.createThread {teamId, title} returned 404 "Team not found". No thread created.
- clearAttention (Dismiss) and stopDiscussion still work in the archived team (see above).

## Console and network
After a clean reload of the archived topic, the console had no errors and no failed resource requests (only the Clerk development-keys warning). Earlier errors were one favicon 404 (out of scope) plus the 403 and 404 from my deliberate refusal calls above. dev.log shows no 5xx or server errors.

## Caveats
Live Team was created but its room was not walked separately; the live-state checks were done on Archive Me before archiving.
