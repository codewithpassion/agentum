# v4 backlog

Tasks moved out of v4 on 2026-11-21, when Dom froze the scope. From then on, only bugs that break a v4 promise, or security and data problems, stay in v4. New features, test tooling and polish wait here.

- TX.10: team memory on the team page (new feature)
- TX.11: the seeded Launch team can dream (dev seed)
- TX.12: one diary post per team per morning (polish)
- TM.15: dictation in the room composer (new feature)
- TM.16: phone room layout (polish)
- SL.9: a sweep for lost room work (reliability tooling)
- DR.13: dream with a scripted model on local (test tooling). The branch `task/DR.13-*` has partial work.
- TM.14: a fake runtime for a team lead (test tooling). The branch `task/TM.14-*` has partial work.
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
