# End-of-v4 browser pass

Run on `origin/main` at d9117cbd, local dev server (`vite dev`, port 5291) with the fake Slack (port 5199), signed in through `/api/dev-login`. Sizes: 1280x800 (desktop) and 390x844 (phone). Screenshots are in `docs/reviews/v4-browser-pass/`.

| Flow | Desktop | Phone |
| --- | --- | --- |
| SL.7 guest name | pass | pass |
| SL.8 Slack markup both ways | fail | fail |
| TX.8 refused hand-off wake retried | pass | pass |
| TX.9 team dream question names the team | pass | pass |

Console and network: no page errors and no failed tRPC request in any flow. The console logged one `Failed to load resource ... 400` per page load of the room and the desk. The network log has no status column, so I could not say which request it is. It is probably Clerk's dev instance, and it is not an app route. No horizontal overflow at 390 wide (`scrollWidth` 390).

## SL.7 guest name: pass, pass

Setup: seeded the Launch team with `seed-slack-room.ts`, linked `#sl5-room` on the team page, then posted as the guest through the fake (`POST /_say`, user `U0GUESTGUS`).

Steps and result: the guest's message opened a topic in the team room. The post shows "Gus Guest" with a muted "Slack guest" tag, and the text has no `(Slack guest):` prefix. The database row has `author_id = slack:T0SL5LOCAL:U0GUESTGUS`, `guest_name = Gus Guest`, and the text starts at the message itself. The phone layout shows the same.

Screenshots: `sl7-desktop.png`, `sl7-phone.png`.

## SL.8 Slack markup both ways: fail, fail

Inbound. The guest wrote `hi <@U0ADALOCALBOT> and <@U0DEVPERSON>, see <https://example.com/doc|the launch doc> and <https://example.org/raw> in <#C0SL5ROOM|sl5-room> &amp; more`.
- The mentions, the channel and the entity read cleanly: `@ada`, `@Dev Person`, `#sl5-room`, `&`. A bare link reads as its URL. Pass.
- The labelled link reads as raw markdown, `[the launch doc](https://example.com/doc)`, in the room post, the topic title, the topic list and the Needs you drawer. Fail. This looks like a product bug. `readSlackMarkup` turns a labelled link into markdown (`packages/services/src/slack/room-text.ts:122`), but `apps/web/src/components/room/room-post.tsx:61-63` renders only agent posts through `<Markdown>`. A member's or guest's post is plain text, so the markdown shows as typed. Agent posts render the link correctly (see `sl8-phone.png`, "the launch doc" underlined). The fix is one of: render inbound text with `<Markdown>`, or have the reader emit `label (url)` for a post that is not rendered as markdown. The title and the drawer use the stored text too, so the second choice covers them.

Outbound. Dev User posted `@ada please read **this** and open [the spec](https://example.com/spec) & report`. The fake received `*Dev User:* @ada please read *this* and open <https://example.com/spec|the spec> &amp; report`. Markdown became mrkdwn and `&` was escaped. Pass for that part.
- `@ada` stayed plain text. That is by design and not a bug: `withMentions` converts only people linked to Slack users (`mentions.ts` indexes email, local part and Slack names), and Ada is an agent. The task's check wording "an `@ada` goes out as a real mention" does not match the code. With `@dev-person` the fake received `Thanks <@U0DEVPERSON>, ping @Dev Person too.`, a real mention. `@Dev Person` with a space is not converted, because a name stops at the space.

Verdict: fail on the labelled link (product bug). The outbound half passes, with the `@ada` wording a task-text problem.

Screenshots: `sl8-desktop.png`, `sl8-phone.png`.

## TX.8 refused hand-off wake is retried: pass, pass

Setup (deviations): no Anthropic key is set locally, so a real team dream could not run. I seeded what the dream's `announce` writes: a "Team diary" topic in Launch with a system post "Hand-off rework in the team room. ..." (the heading `hand-off-retry.ts` matches). I put Ada, the lead, at the wake limit with real traffic: 12 `@ada` messages through the fake Slack gave 10 inbox runs in the hour. The hour cannot pass, so I moved the `created_at` of the inbox runs back by two hours with SQL before the later tick. The minute tick does not run under `vite dev`, so I called it with `curl "http://localhost:5291/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`.

Steps and result:
1. With 10 inbox runs in the hour, the tick ran (`ok`). The Team diary topic held the one request and no run started (still 10 runs). `tx8-before-desktop.png`.
2. After moving the runs out of the window, the next tick started one Ada run, and Ada answered in Team diary (agent post "Echo: Hand-off rework ..."). 11 runs.
3. A further tick started nothing (still 11 runs, 2 posts). The retry fires once.

Note: the seeded request has a later id than Ada's answer, so the room lists Ada's answer above the request. That is a seed artefact. Screenshots: `tx8-before-desktop.png`, `tx8-desktop.png`, `tx8-phone.png`.

## TX.9 team dream question names the team: pass, pass

Setup (deviation): no model key, so I inserted a `dream_runs` row and an open `dream_questions` row for the Launch team directly (`agent_id` null, `team_id` set, two options). The desk chooses Ada, the lead, as the card's agent.

Result: the Needs you drawer lists "Launch has a question from its team dream" (the subline still reads "Question from its dream"). The home page chip and the desk card heading (`/desk?item=<id>`) read the same, with "Ada" under the heading and the two "Keep this one" options. Both sizes.

Screenshots: `tx9-desktop.png`, `tx9-phone.png` (the drawer), `tx9-card-desktop.png`, `tx9-card-phone.png` (the card).

## Environment notes

- The browser needed `AGENT_BROWSER_EXECUTABLE_PATH` set to the headless shell in `~/.cache/ms-playwright/chromium_headless_shell-1248/`, as TX-e2e says.
- Env files (`apps/web/.env`, `.env.local`) are untracked, so I copied them into the worktree. They are not committed.
- I read the local database with `sqlite3 -readonly` while the page ran, once with a plain file copy that missed the WAL. No lock errors showed.
