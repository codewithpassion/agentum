# v4 backlog

Tasks moved out of v4 on 2026-11-21, when Dom froze the scope. From then on, only bugs that break a v4 promise, or security and data problems, stay in v4. New features, test tooling and polish wait here.

- TX.10, TX.11, TX.12, TM.15, TM.16, SL.9, DR.13 and TM.14 went back to docs/tasks/ on 2026-11-22, on Dom's call.
- FX.5, FX.6: fixes for load-flaky tests, replaced by FX.7, which disables those tests

Each file keeps its scope and log. To bring one back, move it into docs/tasks/.

## Later items from the end-of-v4 test pass

From the FR.5 walkthrough (`docs/reviews/FR-e2e.md`):
- Local Cloud and Anthropic cloud runs need the dev port to match `PUBLIC_BASE_URL`, or a tunnel, and a failed run shows developer text in the conversation.
- The runtime choice at Create ("Anthropic cloud" and "Cloud") has no explanation.
- A finished task shows stale state: the side list says "Running", and the Log tab reads "Log 0".
- Cost varies a lot between agents for the same hello ($0.09 against under $0.01).
- The first failed message lands in Needs you with no cause on its card.
- `/login` showed no dev-login link.
- Step 1 on Home shows a doubled "Anthropic API key" heading.

From the TX gate review, round 1 (nits):
- A discussion whose lead is over its hourly wake limit ends as done, with no note in the room.
- Refused member wakes in a discussion repeat every minute and log an event each time.
- Discussion wakes are counted with an unescaped `LIKE` pattern.
- A member's daytime Dream now can start a team dream early.
- A topic someone names "Team diary" is skipped by the dream.
- Undo after an answered team question leaves the answer in place.
- A team dream refused at the workspace cap retries every minute.

From the end-of-v4 browser pass: `@ada` stays plain text going out to Slack because Ada is an agent, so the SL.8 task wording does not match the code.
- The room's topic title and topic list rows still show a labelled Slack link as raw `[label](url)` text (end-of-v4 browser re-check). SL.14 fixed only the post body.

From the HM browser pass (`docs/reviews/hm-browser.md`, 2026-11-23):
- (Fixed by HM.6 on 2026-11-23.) While a task works with a queued reply, "Right now" showed the queued message and two spinners showed.
- On first load, agentum.rockyshoreslabs.io may log CSP `connect-src` errors for `data:` from the Turnstile script.
- The Cloud (Pi) steer path of HM.4 was tested only against the faux Pi, not a real Cloud session.
