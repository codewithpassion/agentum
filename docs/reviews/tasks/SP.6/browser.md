# SP.6 browser walkthrough

Local dev (`vite dev` on port 3417, local D1), at 1280x800 and 390x844. Signed in through the dev login (`/api/dev-login`) in a headless Chromium. `bun run agent-login` printed a valid ticket URL, but the session it opened landed on the signed-out page, so I used the dev login instead.

## Setup

`scripts/dev/seed-fake-agent.ts` made the workspace and the agent "Fake echo". I then wrote directly into local D1 with sqlite3: the agent's weekly cap to 100 cents, and two finished dream rows for it this week, one at $0.99 (20 Nov) and one at $0.02 (21 Nov). Together that is $1.01 of a $1.00 cap, with nothing paused yet. The Chat page showed no pause before the dream (agent row `paused_at` null).

## What I did

On the agent's Knows tab I pressed Dream now. The agent had nothing new to read, so the dream ended as `skipped`. No workspace Anthropic key was set, so no model call was made. The dream still ended through the new `enforceCap` call.

## Result

The agent row went to `paused_at` set and `paused_reason = spend_cap`. The agent page shows "$1.01 of $1 this week" and "Paused. Weekly limit reached". The Needs you drawer holds one item, "Paused at its weekly limit: Fake echo stopped at its weekly limit", at both sizes.

- `desktop-1-agent-paused.png`, `desktop-2-needs-you.png`
- `phone-1-agent-paused.png`, `phone-2-needs-you.png`

## Limits of this proof

A real dream whose own cost tips the agent over could not run here: it needs a workspace Anthropic key and I did not spend one. So the seeded rows already put the agent over the cap, and the dream only triggered the enforcement. The case where the dream's own cost is the one that crosses the cap is covered by the service test in `packages/services/src/dream/run.test.ts` (a $0.00499 prior plus the fake dream's $0.00002 against a one-cent cap), and a dream under the cap pausing nobody is covered by the second test there.
