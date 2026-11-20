# SP end-to-end: the spend walkthrough

Task SP.5, branch `task/SP.5-spend-e2e`. The walkthrough ran on local against the dev server of this worktree, with the fake runtime and seeded usage rows. It walked the pause and resume flow from mail and from the UI, and compared the Spend page with a hand sum of `runs.usage` and `dream_runs.usage`. A fresh verifier repeated it in the browser at 1280x800 and 390x844 (`docs/reviews/tasks/SP.5/browser.md`). The pause, the refusals, the mail notice and Resume all work. The page matches the hand sum to the cent except where it rounds (finding 3), and it leaves out a team dream (finding 1). Five gaps are proposed as tasks below. No product code changed on this branch. The only additions are the seed script and its test.

## What ran

`bun scripts/dev/seed-spend.ts` (new) writes the data. It sets the workspace timezone to Australia/Sydney, so a week boundary falls between two UTC days. It makes two fake-runtime agents, "Fake echo" and "Fake second", and 17 finished runs with known costs. It adds four dream runs, three for agents and one for a team, priced at claude-haiku-5-5 ($0.10 in and $0.50 out per million tokens). It also adds an active mailbox for Fake echo, `sp5-local-echo@agents.rockyshoreslabs.io`.

The mailbox row is written straight into local D1. Creating one through the app calls the Cloudflare Email Routing API with the token in `.env.local`, so the walkthrough blanks `CF_EMAIL_ROUTING_TOKEN` in the worktree's copy of that file and never provisions a mailbox from the UI.

Mail goes in through the dev server's own email endpoint: `POST /cdn-cgi/handler/email?from=<sender>&to=<address>` with a raw message as the body. It reaches the Worker's `email()` handler and the real inbound path: the mailbox Durable Object, the thread index and the trigger run. The fake runtime reports no cost, so a finished run never changes the totals. The seed puts Fake echo at $1.05 this week, and a cap below that pauses it when the next run finishes.

Seeded usage, in USD. Weeks start Monday in the workspace timezone. Dry runs and tokens-only usage are in the data on purpose.

| Row | When (local) | Usage |
|---|---|---|
| Fake echo runs | week of 19 Oct, 26 Oct | 1.50, 0.75 |
| Fake echo runs | week of 2 Nov | 1.20, 1.00, 0.80 on three days |
| Fake echo runs | last week | 0.004 on each of three days, 1.50 (with tokens), 0.35 on Sunday 23:40, a run with tokens and no cost, a dry run of 9.99 |
| Fake echo runs | this week | 0.25 on Monday 00:20, 0.30 (a failed run) and 0.10 |
| Fake echo dreams | last week, this week | 1,000,000 in and 200,000 out (0.20), 2,000,000 in and 400,000 out (0.40) |
| Fake second | last week, this week | run 2.00, run 0.45, dream of 500,000 and 100,000 tokens (0.10) |
| Team dream | this week | 3,000,000 in and 600,000 out (0.60) |

## Hand sum against the page

The hand sum is raw SQL on the local database, with no service in between (query at the end of this file). The page and the hand sum agree on every cell but one, and that one is a rounding rule.

| Agent | 19 Oct | 26 Oct | 2 Nov | Last week | This week |
|---|---|---|---|---|---|
| Fake echo, hand sum | 1.50 | 0.75 | 3.00 | 2.062 | 1.05 |
| Fake echo, page | $1.50 | $0.75 | $3.00 | $2.05 | $1.05 |
| Fake second, hand sum | 0 | 0 | 0 | 2.00 | 0.55 |
| Fake second, page | $0 | $0 | $0 | $2.00 | $0.55 |
| Page total row | $1.50 | $0.75 | $3.00 | $4.05 | $1.60 |

The Sunday 23:40 run counts in last week and the Monday 00:20 run in this week, as the Sydney calendar says. Only the Monday run tests the zone: at 13:20Z on Sunday it would count in last week if the page used UTC. The dry run, the tokens-only run and the cost-less fake runs add nothing. The dreams add their `costUsd`, which matches input and output tokens at the Haiku rates ($0.40 for 2,000,000 in and 400,000 out). A failed run counts too. The agent header pill, the Home card and the table agree with each other.

| Check | Result |
|---|---|
| Cap $1 on Fake echo, a mail arrives | The mail starts a run. It finishes Done and the agent is paused (reason `spend_cap`) in the same second. A Needs you card appears. The run in flight was not touched. |
| A mail to the paused agent | The sender gets a reply, "Fake echo is paused. Its weekly limit was reached.", shown in the agent's mail sheet. A second mail in the same thread gets no second reply. No run starts. |
| Resume (same cap, still over) | The agent resumes. The next mail starts a run, and the agent pauses again as it finishes (finding 4). |
| Raise the limit to $20 | The agent resumes and the next mail runs with no pause. |
| Workspace cap $2.00 | Nothing pauses. The seeded week is $2.20 with the team dream, and $1.60 without it (finding 1). |
| Workspace cap $1.50, a run on Fake second | Both agents pause. The card for Fake echo says the workspace limit was reached and that raising the agent's limit will not restart it. |
| Dream now on a paused agent | Refused with "Fake echo is paused, so it does not dream". |
| Start a task in the UI on a paused agent | Refused in the dialog, with a 409 in the network log (the designed refusal, checked in `browser.md`). |

## Findings and proposed tasks

They run from most to least important. Each proposed task has a scope and a check. None is done here, and the ids are suggestions for the controller.

### 1. A team dream is not in the page total or the workspace cap

On this branch `spend.read` joins `dream_runs` to `agents`, so a row with `agent_id` null (a team dream) drops out of every sum. The seeded team dream of $0.60 is in the hand sum and not in the page: this week reads $1.60 where the data says $2.20. A workspace cap of $2.00 pauses nobody. The controller already decided (TX.2 log, 20 Nov) that a team dream counts toward the workspace's weekly spend and cap. TX.2 carries that change in `spend.ts` and `spend-rollups.ts`, and it is not merged yet. This is an expected gap, not a new task. Check it after TX.2 merges: rerun this walkthrough, and the page's this-week total and the workspace-cap pause must include the $0.60.

### 2. A dream that crosses a cap pauses nobody

Proposed task SP.6, "A dream that ends over a cap pauses its agent".

`enforceCap` is called from `runs.ts` only (the two places a turn ends, lines 2164 and 2303). The dream service has no `spend` dependency, and `compose.ts` builds it without one. A dream's cost counts toward the week, but if it is the spend that crosses the cap, nothing pauses until some run finishes. A dream often runs when an agent is otherwise idle, so a cap passed by a dream can stay unenforced for days. I read this from the code and did not run it live. A dream needs a workspace Anthropic key, and the scripted model (DR.13) is not built.

Scope: give `createDreamService` an optional `spend: Pick<SpendService, "enforceCap">`, as `runs.ts` has, and call it when an agent's dream ends and recorded usage. For a team dream, call a workspace-wide check that pauses every active agent when the workspace is over its cap. That part follows TX.2. Wire it in `compose.ts`.

Check: a service test with the fake model. An agent at $0.99 of a $1.00 cap runs a dream that costs $0.02, and ends paused with reason `spend_cap` and a Needs you item. A team dream over the workspace cap pauses every active agent. A dream under the cap pauses nobody. `bun run check && bun run test && bun run build` pass. Then repeat the walkthrough with the seeded dream rows.

### 3. The page rounds each agent-day, so small spend disappears

Proposed task SP.7, "Spend rounds the week, not each day".

`rollupSpend` rounds cents once per agent and day. Three days of $0.004 each show as $0 each, and the page reads $2.05 for last week where the data says $2.062. DR.7 measured a Haiku dream at $0.0006 to $0.0018. One a night adds under a cent to a day, so an agent that only dreams shows $0, and the cap check cannot see that spend either.

Scope: sum the unrounded USD for a week and round once, for the page cells, the agent header, the card line and `weekToDate`. `SpendRow` keeps `cents` per day for the bars and gains a field with the unrounded amount, for example `micros`, millionths of a dollar as an integer. The sums use that field. The cap check and the page must give the same figure.

Check: a rollup test with three days of $0.004 gives a week of $0.01 where today's code gives $0. A cap test where only small dreams cross the cap pauses the agent. The walkthrough's last week for Fake echo reads $2.06.

### 4. Resume at the same cap is one more run, then a pause

Proposed task SP.8, "Resume says what it will do".

When an agent is paused at $1.05 of a $1.00 cap, Resume (without raising the cap) clears the pause, the next run starts, and `enforceCap` pauses the agent again as that run ends. SP.3's spec lets a run through before the pause lands, and the card does not say so. It reads only "The limit is $1 a week." with Resume and Raise the limit. The owner who clicks Resume gets one run and a new Needs you card. A mail that arrived during the pause is stored and never run, and the notice does not tell the sender to send it again.

Scope: the pause card shows the week-to-date next to the limit, "$1.05 of $1 this week". When the week-to-date is at or over the limit, the card drops Resume and offers Raise the limit alone. The mail notice adds "Send it again once the agent is resumed."

Check: component tests for both card states. A mail service test that the notice carries the line. A browser pass at both sizes.

### 5. A cap pause does not lift on Monday

Question for Dom, then proposed task SP.9, "A cap pause ends with its week".

Only `spend.resume` clears `paused_at`. A grep finds no other place. A cap is weekly, but an agent paused on Wednesday stays paused past the next Monday, when its week-to-date is $0 again, until a person clicks Resume. I read this from the code and did not run it live, because the clock would have to cross a Monday.

Scope if Dom agrees: the minute tick clears `spend_cap` pauses when the agent's and the workspace's week-to-date are under their caps. The Needs you card is derived from the pause, so it goes too. A `manual` pause stays.

Check: a service test with the clock set across Monday 00:00 in the workspace timezone: paused on Sunday, resumed by the tick on Monday. A `manual` pause is untouched. An agent whose cap is still below its week-to-date is not resumed.

### 6. The Home card and the Spend page count differently

Proposed task SP.10, "The Home card shows the Spend page's week".

Without a limit, an agent's Home card shows the roster's figure, `costThisWeekCents`. The roster adds up the last seven days of runs in sessions the viewer can see (`runFacts` in `roster.ts`), and the Spend page adds up the calendar week of every run in the workspace. With a limit set the card switches to the Spend page's figure (`withLimitWeekSpend`, SP.4). In the seeded data the runs sit in another user's private sessions, so Fake second's card read "$0 this week" next to "$0.55" on the Spend page. Two members with their own private threads would see the same split. The label says "this week" in both places.

Scope: the Home card, and the Cost this week column of the agents table, read this week's cents from the same `spend.workspace` rows the page uses, for every agent, with or without a limit. The roster drops `costThisWeekCents` if nothing else reads it.

Check: a component test where the roster says $0 and the spend rows say $0.55, and the card reads $0.55. A browser pass: seeded Fake second shows "$0.55 this week" on Home with no limit set, at both sizes.

### Smaller things

- Setting a cap below the week-to-date pauses nothing at once. The pause lands when the next run ends, and that run still starts. SP.3's spec says so, and the Settings field text does not.
- Dream now on a paused agent answers 409, so the browser console logs a second "Failed to load resource ... 409" next to the one from Run now. It is the same designed refusal, but a person with the console open sees two errors.
- The mail sheet says "1 messages" for a one-message thread, and the reply in a thread shows "Sent" twice (the direction and the status). Neither is spend code.
- On the Spend page the dashed "Workspace limit" label sits on top of the This week bar and its value label, clearly at phone width, and the bar tooltip covers the value label on desktop.
- Both browser passes saw the `400` console error in the dev-login hop (known noise).

## Steps for Dom

Decide finding 5, whether a cap pause lifts itself on Monday. Nothing needs his accounts.

## The hand-sum query

Run it with `sqlite3` against the newest file in `apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/`. It assumes the seeded timezone, Australia/Sydney, which is UTC+11 until the clocks change in April 2027. Weeks start Monday. `(team dream)` is a row with no agent.

```sql
-- One workspace in the local database. Add a workspace_id filter if there are more.
WITH facts AS (
  SELECT agent_id, datetime(created_at, '+11 hours') AS local,
         COALESCE(json_extract(usage, '$.costUsd'), 0) AS usd
    FROM runs WHERE dry_run = 0
  UNION ALL
  SELECT agent_id, datetime(started_at, '+11 hours'),
         COALESCE(json_extract(usage, '$.costUsd'), 0)
    FROM dream_runs
), weeks AS (
  SELECT agent_id, usd,
         date(local, '-' || ((CAST(strftime('%w', local) AS INT) + 6) % 7) || ' days') AS week
    FROM facts
)
SELECT COALESCE(a.name, '(team dream)') AS agent, week, ROUND(SUM(usd), 4) AS usd
  FROM weeks LEFT JOIN agents a ON a.id = weeks.agent_id
 GROUP BY agent, week ORDER BY week, agent;
```

To rerun the walkthrough on a clean machine: apply migrations, start the dev server, sign in with the dev login once, blank `CF_EMAIL_ROUTING_TOKEN` in `apps/web/.env.local`, run `bun scripts/dev/seed-spend.ts`, then send mail with `curl -X POST "http://localhost:<port>/cdn-cgi/handler/email?from=pat@example.com&to=sp5-local-echo@agents.rockyshoreslabs.io" --data-binary @message.eml`.
