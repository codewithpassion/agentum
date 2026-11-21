# SP.6 browser walkthrough

Local dev (`vite dev` on port 3417, local D1), headless Chromium at 1280x800 and 390x844, with a real dream against the real Anthropic API. The dev key was set as the workspace key in the local database through Settings, Model providers, and removed there afterwards. It is in no file, log, commit or screenshot.

## Sign-in

`bun run agent-login --base-url http://localhost:3417` printed a valid Clerk ticket URL, but the browser it opened ended on the signed-out page (`/login`), so no session came of it. I signed in through the local dev login (`/api/dev-login`) instead.

## Setup

`scripts/dev/seed-fake-agent.ts` made the workspace and the agent "Fake echo". `scripts/dev/seed-dream.ts` gave it ten conversations to dream about. The agent's cap and one earlier finished dream row were written with sqlite3 into local D1. No other dream row was in the week.

## Run A: $0.99 of a $1.00 cap

Before: cap 100 cents, one earlier dream of $0.99, agent active, Needs you empty (`*-a1-before-*`). I pressed Dream now on the Knows tab and the real dream ran to `done`. It cost $0.0004956 (1,986 in, 594 out). After: $0.9905 is under the cap, the agent stays active and nothing is paused (`*-a1-after-*`). This is the "a dream under the cap pauses nobody" case.

## Run B: the real cost crosses the cap

The real dream costs under $0.01, so a $1.00 cap cannot be crossed by it. Per the coordinator I lowered the cap to 1 cent and set the earlier dream to $0.0049, which rounds to 0 cents. I removed run A's row and seeded the ten conversations again (round 2) so the dream had something to read.

Before: "$0 of $0.01 this week", agent active, Needs you empty (`*-a2-before-*`). I pressed Dream now. The real dream ran to `done` and cost $0.0019318 (9,053 in, 2,053 out). The week became $0.0068, which rounds to 1 cent. After: `paused_at` set, `paused_reason = spend_cap`, the agent page shows the red "Paused. Weekly limit reached" badge, and Needs you holds "Paused at its weekly limit: Fake echo stopped at its weekly limit" (`*-a2-after-*`). The other Needs you item, "Fake echo has a question from its dream", is the dream's own question and unrelated to the cap.

Files: `desktop-` and `phone-` each with `a1-before`, `a1-after`, `a2-before`, `a2-after`, as `-agent.png` (the agent page) and `-needs-you.png` (the Needs you drawer).
