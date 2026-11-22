# HM browser pass (HM.1 to HM.5)

Run on branch `task/HM-browser` (from main at ba50e8d4), local dev server on port 3419, headless Chrome through agent-browser, signed in with the dev login. Sizes: 1440x900 and 390x844. Screenshots are in `docs/reviews/hm-browser/`. No product code was changed.

## Verdicts

| Flow | Desktop | Phone |
| --- | --- | --- |
| 1. HM.1 Home roster | pass | pass |
| 2. HM.2 tab bar | pass | pass |
| 3. HM.3 learned this week | pass | pass |
| 4. HM.4 reply while working | pass | pass |
| 5. HM.5 newsletter form | pass with notes | pass with notes |

No must-fix bug found.

## 1. HM.1 Home roster

Steps and results, desktop:
- Measured every tile on /home. Agent cards, Add to team, New agent and Start from a template are all 373x176. Pass. (`hm1-desktop-scrolled.png`)
- Tall card: no agent card is naturally taller, so I forced Cy's card to min-height 300px in the DOM. The Add to team tile in the same row grew to 300px too, and the later row stayed 176. This is a simulated tall card. (`hm1-desktop-tall-card.png`)
- Typed `c` with body focused: the filter field opened with "c", cards narrowed to Cy and Fake echo, other agents hidden. Typing `zzq` showed `No agent matches "zzq".` and kept the New agent and template actions. Esc removed the field and restored all 7 items. (`hm1-desktop-search-c.png`)
- List view toggle: rows show avatar, name, status dot, activity, owner, cost. New agent, template and Add to team stay as rows. After a reload the list view is still active (`hm:roster-view = list`, List view pressed). (`hm1-desktop-list.png`, `hm1-desktop-list-reload.png`)

Phone: tiles all 358x176, no horizontal scroll (scrollWidth 390). Typing `c` filters to Cy and Fake echo, Esc closes the field. List view shows rows (name, dot, cost; owner and activity hidden below md, a known nit) and survives a reload. (`hm1-phone-*.png`)

## 2. HM.2 tab bar

- Tablist computed style: overflow-x auto, overflow-y hidden, scrollbar-width none. clientHeight, offsetHeight and scrollHeight are all 38, so there is no vertical overflow to scroll. The selected tab's bottom edge equals the bar's bottom edge (216 and 216), its 2px border sits on the inset bottom line. (`hm2-desktop-tabs.png`)
- Phone: clientWidth 390, scrollWidth 470. Setting scrollLeft moved it to 80, so the tabs scroll sideways. Settings is off screen at the start. No page-level horizontal scroll. Selected underline still sits on the line. (`hm2-phone-tabs-start.png`, `hm2-phone-tabs-scrolled.png`)
- Limit of this check: headless Chrome hides scrollbars, so I proved "no scrollbar" through the metrics above, not by eye.

## 3. HM.3 Learned this week

Setup: the scripted dream only produced 2 notes per agent and later dreams said "Nothing changed". I added 6 more rows of `memory_changes` for the Fake echo agent straight into the local D1 file (copies of a dream row, one with a 400-character text), and set learn level back from Quietly to Ask me first (Quietly hides dream rows). That gave 8 learned items.

Desktop (Chat tab, `hm3-desktop-collapsed.png`, `hm3-desktop-expanded.png`):
- 3 items plus a "Show all (8)" button, each with Undo. Show all expands to 8, "Show less" folds back to 3.
- The long item is clamped to 3 lines (line-clamp 3, 60px of 180px content) and its title attribute holds the full text.
- Side column: max-height 630px, overflow-y auto, scrollHeight 1021 collapsed and 1566 expanded, so it scrolls on its own. The conversation stays 628px high in all states. Document height is 955 against a 900 window, which is the footer below the 630px row, not the side column.

Phone (`hm3-phone-collapsed.png`, `hm3-phone-expanded.png`): the side column stacks above the conversation as before. Collapsed shows 3 plus Show all (8), expanded shows 8 plus Show less. Conversation box is unchanged.

## 4. HM.4 Reply while working

A fake-runtime task finishes at once, and a fake `ask:` run waits for approval, which the page treats as "waiting" with a banner, not "working". So I used the machine runtime: enrolled the fake daemon (`scripts/dev/fake-daemon.ts`) without `--echo`, so it receives the offer but never claims. The task then stays queued/offered and the page shows "Task 1 is working."

Desktop:
- The reply box stays visible below the working indicator, with the line "The agent gets this when the current step ends." Stop stays available. (`hm4-desktop-typed.png`)
- Sent a second message: it appears as Dev User's message marked "Waiting for the current step to end" with a Remove button. (`hm4-desktop-queued.png`)
- Sent a third message, then removed it. Its run went to `cancelled` in the database and the message left the conversation. (`hm4-desktop-two-queued.png`, `hm4-desktop-after-remove.png`)
- Restarted the daemon with `--echo`. It claimed and completed task 1, then the queued second message ran as task 2 ("Echo: second message queued"). The cancelled one never ran. Composer then reads "Sending starts task 4". (`hm4-desktop-done.png`)

Phone: same box, note, queued message with Remove, and removal. (`hm4-phone-typed.png`, `hm4-phone-queued.png`, `hm4-phone-removed.png`) Only the end-of-step run was not repeated at phone size.

Observations, not blocking:
- The "Right now" card shows the newest queued message's text as its title ("second message queued"), not the task that is working.
- Two "Working" spinners show, one under the first task and one under the queued message.
- A removed message still counts in task numbering ("Task 1 of 3", next is task 4), as the review already noted.
- The Cloud (Pi) steer path was not run here, only the queue path on a machine agent.

## 5. HM.5 Newsletter form

Local (`hm5-desktop-form.png`, `hm5-phone-form.png`):
- Turnstile widget renders under the Subscribe button with Cloudflare's test key, shows "Success!", and sets `cf-turnstile-response` to the dummy token. The form is one full-width email column, plus a hidden honeypot `website` input (tabindex -1). The widget sits tight under the button with no top margin (known nit).
- `.env.local` had no newsletter secrets, so I added Cloudflare's always-pass test secret and dummy `NEWSLETTERS_API_KEY` and `NEWSLETTERS_NEWSLETTER_ID` values (file is not tracked). Submitted `hm-browser-test@example.com`.
- Result: the form shows "Something went wrong, please try again." in red. The server log shows `newsletter_signup httpStatus 401 outcome upstream`, because the dummy key is refused upstream, and the route answered 502. That is a clear error and no upstream text reached the browser, but I could not see the success message without a real key.
- Network log: one `POST http://localhost:3419/api/newsletter/subscribe` per submit. Filter `public` returned nothing, so no request to `/api/public/newsletters` or to rockyshoreslabs.io came from the browser. (agent-browser lists each request three times; the dev log shows one `newsletter_signup` line per submit.)
- Console on local: only the Clerk dev-key warning and the browser's own "Failed to load resource 502" line for that POST.

Production, read only, nothing submitted (`hm5-prod-agentumbot-desktop.png`, `hm5-prod-agentum-desktop.png`):
- https://agentumbot.io/ and https://agentum.rockyshoreslabs.io/ both show the form with the Cloudflare "Verify you are human" widget under Subscribe.
- Console: both pages had only warnings (font OTS parse, WebGL fallback) on the first loads, except agentum.rockyshoreslabs.io, which logged four errors once: `Connecting to 'data:,' violates ... Content Security Policy directive connect-src` (and a matching "Fetch API cannot load data:,"). They come from Turnstile's own script under that page's CSP. After I cleared the console, later loads of both sites showed no errors. So the old site's CSP is worth a look, since `connect-src` has no `data:`, but the widget still rendered. Because the capture is ambiguous, treat this as a possible nit.

## Not covered

- No real success path for the newsletter form (needs real secrets).
- Cloud (Pi) steer in HM.4.
- Real scrollbar look in HM.2 (headless hides scrollbars).
