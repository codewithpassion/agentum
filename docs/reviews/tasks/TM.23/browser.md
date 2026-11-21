# TM.23 browser verification

Verdict: pass (with one observation under flow 4).

Setup: commit 037e89bc, vite dev on port 3147, local D1 migrated, dev login. Seeded one workspace: "Old Topic Team" with one topic ("Ancient lonely topic", last_post_at 2026-01-01) and 60 newer topics (30 Everyone, 30 "Other Team", last_post_at 2026-06-01). SQL check: 60 topics are newer than the old one and the old topic is not in the workspace's newest 50 (`in_top50 = 0`). The dev user is a member of both teams. Seed SQL in tmp/TM.23/seed.sql.
Checks: console read via agent-browser (no errors, only vite debug, React devtools info and the Clerk dev-keys warning). Failed requests checked via PerformanceResourceTiming (no status >= 400 or 0) and vite.log (no errors). No page-level failures; favicon excluded.

## Flow 1, seed
Done as above.

## Flow 2, old topic listed and opens
- Desktop: /teams/<old>/room lists "Ancient lonely topic" (desktop-2a.png). Clicking it gives ?topic=THREADOLD..., posts show "Hello from the ancient topic post" (desktop-2.png). Pass.
- Phone: list sits behind the "Topics" button. Opened it, the old topic is listed (phone-2a.png), tapping it shows the post (phone-2.png). Pass.

## Flow 3, rooms list only their own topics
- Desktop: Everyone room shows 30 Everyone topics, no "Other topic" or "Ancient" (desktop-3a.png). Other Team room shows 30 Other topics, no Everyone or Ancient (desktop-3b.png). Pass.
- Phone: same counts (Everyone 30, Other 0 / Other 30, Everyone 0, no Ancient) (phone-3a.png, phone-3b.png). Pass.

## Flow 4, switch room with no reload (Find dialog)
- Desktop: Old -> Other Team room, Other -> Old room, via Find. A window marker survived, so no full reload. Final state correct each time: Other room shows 30 Other topics and no Ancient (desktop-4b.png); Old room shows only Ancient (desktop-4c.png). Pass.
- Observation: for about 1 to 1.5 s after the click the URL already shows the new team while the previous room (heading, list, all consistent as the old team) stays on screen until the new loader finishes (desktop-4a.png, taken 0.4 s after the click). The new room itself never rendered with the previous room's topics. This is the router keeping the old route up while the loader runs, in dev. Reported for the dispatcher to judge.
- Phone: Menu -> Find -> room, Old -> Other, Other -> Everyone, Everyone -> Old. Marker survived each time. After each, the Topics sheet shows only that room's topics (phone-4a.png Other: 30 Other, 0 Ancient; phone-4b.png Everyone: 0 Other; phone-4c.png Old: Ancient only). Pass.

## Flow 5, room still updates
- Desktop: New topic -> "Fresh desktop topic" -> Create. URL moved to the new topic and it appears at the top of the list above the Ancient topic (desktop-5.png). Pass.
- Phone: Topics -> New topic -> "Fresh phone topic" -> Create. Reopened Topics: it is listed first, above "Fresh desktop topic" and Ancient (phone-5.png). Pass.

Screenshots: desktop-2a, desktop-2, desktop-3a, desktop-3b, desktop-4a, desktop-4b, desktop-4c, desktop-5, phone-2a, phone-2, phone-3a, phone-3b, phone-4a, phone-4b, phone-4c, phone-5 (all .png, same folder).

Note: the default agent-browser Chrome would not launch, so a Playwright headless shell and a profile under tmp/TM.23/profile were used. Local D1 now holds the seeded data and two "Fresh" topics.
