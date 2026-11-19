# What Agentum should take from IndyDevDan's small agent teams

Source: IndyDevDan, "Fable 5.2 is CRACKED but THIS goes BEYOND THE MODEL", 16 Nov 2026,
27 minutes. Tiny Software Factories lesson 3. https://youtu.be/hYIymEMB9x4
Transcript pulled with Supadata. His code: github.com/disler (57 public repos). I read the
READMEs of super-simple-software-factory, durable-pi, pi-durable-news-agent, the-library,
the-verifier-agent, self-compact-pi-agent, fusion-harness and inkwell.

Written 18 Nov 2026. Nothing here is implemented. No task files exist yet.

## His argument, in one paragraph

The model is not the edge, because everyone has the same models. The edge is the system around
it: context, model, prompt, tools, which he calls the core four. A generic agent with default
tools and a context window full of every problem loses to a focused agent with focused tools
and a prompt carrying the team's rules. One super-agent is a myth, plain sub-agent delegation
hits a ceiling, and swarms cost more to coordinate than they return. What works is a small team
of durable specialists, each owning one lane, with one orchestrator in front and the human near
the loop rather than in it.

I think he is right about the shape and oversells the novelty. Most of what he demos, Agentum
already has, under different names and in several places more carefully. The parts worth taking
are narrow and specific.

## What we already have

Nine mechanisms from the video, and where each one lives here.

Small agent teams. We have them. The `agents` table carries `model`, `instructions`, `soul`,
`runtime`, `askLevel` and `handsTo` per agent, so each agent is already a specialist with its
own lane and its own owner.

The lead agent. Partly. `agents.handsTo` hands work between agents, `docs/v3/subagents.md`
gives child runs with their own model and narrowed access, and the workspace assistant
(`docs/v3/workspace-assistant.md`) is a single interface onto everything. But the assistant is
a person acting through a model, not a durable agent, and no agent role exists whose only job
is running a team.

Agent chat rooms. We have them, and ours are better built. `inboxThreads` and `inboxPosts` hold
multi-party threads, `inbox/mentions.ts` turns `@slug` into a wake, and `inbox/loop-guard.ts`
stops runaway chatter with two brakes: no more wakes once the last three posts are all from
agents, and ten wakes per agent per hour.

The social contract. Partly. `inbox/wake-input.ts` is our version of his conversation prompt.
It tells the woken agent that its final answer is the reply, that `@slug` wakes another agent,
and it wraps earlier posts in `<untrusted-thread-posts>` markers with `<` escaped, so a post
cannot pose as an instruction. That last part is real engineering his version does not have.
The difference: ours is three fixed lines in source, his is a setting the user edits.

Lead control and access parity. Deliberately not. His lead rewrites its members' models and
tool lists. Ours cannot. One correction worth recording: `docs/v3/mcp-agent-management.md` says
the agent management tools admit a user principal with `via: "session"`, but
`admin-access.ts:requireAgentManager` also admits a write OAuth client and falls through to
`requireKey(principal, action, "write")`. A run principal still cannot manage other agents,
which is the part that matters here, but the doc and the code disagree and the doc is the one
that is wrong.

Human near the loop. We have it, and more of it than he does. `runRequests` carries three kinds
(approval, question, takeover), a `display` shape, `questionKeys`, expiry (one hour for
approvals, a day for questions), `answeredVia` of web, Slack or A2A, and `backupUserId` for the
second person asked when a request waits. `ASK_LEVELS` plus `agent_tool_rules` set how much an
agent asks before acting. His team ask is a questionnaire. Ours is that plus escalation.

The cron tick. We have it: `routines/cron.ts` and triggers.

Observability. Partly, and better than I first thought. Events land as they happen,
`events/summary.ts` cuts each to 120 characters, and `tasks/receipt.ts` already joins a tool
call to its result by tool-use id and folds repeats into steps. The gap is narrower than the
video suggests: `tasks/action-log.ts` still lists entries separately and can lead with raw
output, so a person reading a run still reads traces even though the join already exists.

The empty factory. Mostly. The agent builder, the skills store with versions and approval, and
the library with `packages/library-sync` are our version of shipping templates meant to be
edited.

## What to do first, after all three reviews

My own list is below, but two reviews read the code without seeing it and between them they
beat my ranking. If only three things get done:

1. **Stop an unanswered question parking an agent for a day.** Fable found this and I checked
   it. `apps/agentum/src/approvals.rs:236` sits in `while outcome.is_null()`, long-polling
   `api.wait` until the request closes, and a question's TTL is 24 hours
   (`QUESTION_TTL_MS` in `packages/db/src/shared.ts`). One run per agent on a machine means
   one unanswered question holds that agent's whole lane until tomorrow. This is a defect
   wearing a feature's clothes, and it is exactly the threshold the video is about. The fix:
   end the turn with a tool result saying the answer will arrive later, then wake the agent
   with the answer as a follow-up run in the same session, the way `claude.rs` already
   resumes. Approvals can stay synchronous, since their TTL is an hour.
2. **Render the run link that is already in the inbox.** Both reviews found this
   independently. `inboxPosts.runId` is stored and nothing in
   `apps/web/src/components/inbox/` reads it, so a person cannot get from a specialist's reply
   to the task behind it. Needs a server-side visibility check, because a shared post can
   outlive access to a private run.
3. **Per-agent reasoning effort**, my item 1 below. Both my list and Fable's have it; it is a
   validated field in `runtimeConfig` and a select on the agent page.

## Recommendations

Ranked. Each one names what it touches.

1. **Per-agent reasoning effort and context budget.** `agents.model` is a single string, so
   effort rides along inside the model id or not at all. His roster sets `thinking` per agent
   (off through max) and durable-pi sets compaction thresholds per session. Add both to
   `agents.runtimeConfig`, which is already JSON validated by a zod schema, so no migration
   fight. This is the cheapest item here and it unlocks the one claim of his I believe most:
   run the orchestrator high and the workers medium or low, and the team gets cheaper without
   getting worse. Cost: a schema change, the agent profile UI, and a pass through the places
   that build a model call.

2. **A verifier lane.** From `the-verifier-agent`. A second agent re-runs the first agent's
   claims with read-only tools, breaks every claim into the smallest thing that can be proven,
   prompts corrections back, and escalates to a person after three failed rounds. It is
   deliberately un-promptable: its input is a template, so you fix a gap by editing the
   template and the fix covers the whole class. We have every part already: subagents,
   read-only tool rules, `runRequests` escalation. This one is not theory for us. In this
   build the coordinator reported a prediction about bot-ccau's update notice that turned out
   wrong, and went idle three times holding finished work. A verifier would have caught both.
   Cost: a skill, a prompt template, one agent template. Real risk: it doubles token spend on
   every verified task.

3. **Make the thread contract editable.** Move the fixed lines in `inbox/wake-input.ts` into a
   workspace setting, with a per-thread override, so a workspace can set length, tone and lane
   rules the way he does. Keep the untrusted-posts block and the markers out of reach: editable
   text goes only in the trusted part above them, never near the quoted posts. Without that
   split this is a prompt injection hole, so it is worth doing carefully or not at all.

4. **Decide the parity question, and answer it with proposals.** His lead reconfigures its
   team. Giving an agent `update_agent` on its peers would let one agent widen another's access,
   which is exactly what `requireAgentManager` exists to stop. The version I would ship: a lead
   agent may propose changes to its team's `model`, effort and `instructions`, and each
   proposal lands as a `runRequests` approval for the agent's owner. We already have the
   machinery, and the human stays the only writer for anything touching access, secrets or
   connectors.

5. **Let un-mentioned agents keep up.** Today only `@mentioned` agents wake, so a member learns
   nothing a thread decided unless it was named. His contract has everyone read the room and
   only the mentioned ones speak. I would not copy that literally, since waking every agent on
   every post is what the loop guard exists to prevent. Instead widen the catch-up: make
   `WAKE_CONTEXT_POSTS` and `WAKE_CONTEXT_CHARS` in `inbox/wake-input.ts` per-thread settings,
   so when an agent is finally named it reads what it missed rather than the last ten posts.

6. **Background compaction that keeps the history.** From `self-compact-pi-agent` and
   durable-pi: summarize in the background at one threshold, block at a higher one, keep every
   stored entry, and give the agent a `search_history` tool that pages through everything,
   including what came before a compaction. Our machine agents run for days and hit the same
   wall. The sessions tables already hold the record, so the work is the summary pass plus one
   tool.

7. **One-line tool summaries in the run view.** `events/summary.ts` already cuts events to 120
   characters. Extend the same idea to tool calls in the session view so a person reads
   outcomes, not traces. Small, and it is the one thing in the video that visibly lowers the
   cost of watching several agents at once.

8. **A team starter in the library.** His factory is a skill you stamp into a repo, and the
   prompts belong to you the moment they land. Ours would be a library entry that creates a
   lead plus three specialists with their roster, prompts and tool rules, which the workspace
   then edits. Worth stealing with it: his `protected_files` rule, that no agent may edit the
   machinery that grades it. As a tool rule here, no agent edits its own skill or its
   verifier's template.

## What to skip

Agent swarms, which he also rejects. His transport (unix sockets, tmux windows, session JSONL
on disk) solves a problem our inbox already solves. Self-configuring agents with direct writes,
for the reason in item 4. And his framing that you need a top model only for 500-line specs or
orchestration is a claim about his workload, not a rule.

## Second opinions

Two reviews ran on the same brief, each reading his notes and our code without seeing my list.
Raw outputs are in the scratchpad folder beside the brief:
`/tmp/claude-1000/-home-roboto-devel-harbourmaster/774754b0-265d-4bcd-af7e-42c977b346a4/scratchpad/dan/`.

### Codex, gpt-6.2-sol at medium effort

Newer than the `gpt-6.1-sol` that `scripts/codex-task.sh` pins. Its read of the code is more
careful than mine in four places, and it found one thing I would now do before anything on my
list.

It reads the inbox code as already posting an agent's answer back with the originating `runId`,
and `apps/web/src/components/inbox/post-list.tsx` never rendering it. I checked: `inbox.ts`
does carry `runId` on a post, and `post-list.tsx` does not mention it. So a person reading a
thread cannot get from a specialist's reply to the task that produced it, with the link already
sitting in the data. That is the cheapest honest win in this document, and it belongs above my
item 1. It needs a server-side visibility check, because a shared post can outlive access to a
private run.

Three more corrections, all folded into the section above or worth carrying: `requireAgentManager`
admits more than browser sessions, `tasks/receipt.ts` already does the tool-call join I was
asking for, and a prompt alone cannot strip an agent's built-in tools, so my item 4 needs a real
tool restriction, not only a lead persona. It also found two gaps the video does not cover:
`slack/requests.ts` has no retry for a card whose delivery failed, and no routine records phase
boundaries, so an interrupted routine cannot resume from the last one.

Where we disagree: it ranks a per-minute lead tick as a thing to skip, and I agree, so neither
of us wants that part of the video. It never raises per-agent reasoning effort or background
compaction, which are my items 1 and 6, and I still think both are right. It treats the verifier
as a maybe with caveats rather than a priority. Its caveat is fair, that a verifier needs an
independent source of evidence or it just restates the builder's claims, and I would add that
constraint to item 2 rather than drop it.

### Fable 5.1, the current Fable

The sharpest of the three. It found the question-parks-the-lane defect above, which neither
Codex nor I did, and it is the only review that checked the Rust client's side of a request.

Two of its corrections matter beyond this document. Cloud runs already sit on pi-durable in the
`PiRun` durable object, so "adopt durable-pi" is not a recommendation for us at all. The
durability gap is machine runs only, where a daemon restart ends a run as `interrupted` with a
Retry. And `qa_ask` is a knowledge board, not a decision queue, which its own description says,
so it is not our team-ask surface. `requests.ts` is.

Its list and mine overlap on four items: the editable conversation prompt, proposed agent
changes approved by a person, per-agent reasoning effort, and thread membership for agents that
are not mentioned. On proposed changes it is more specific than I was, pointing at how
`routines.ts`, `triggers.ts` and `skills-store.ts` already run propose-then-approve, so the
pattern exists and the work is one table and one card.

Two things it adds that I would keep. Spend per agent, a `runs.spendByAgent` read and a column
on `/agents`, on the argument that the measure should land on the thing you tune. That is the
right objection to a roster of agents on different models with no way to see what each costs.
And a cheap classifier before a run, from his news agent: `triggers.ts` starts a run on every
call, so a small-model filter on a trigger would let a noisy webhook feed an agent without one
run per event.

It also says to skip the empty factory entirely, as a different product, where I had it as
mostly ours already. It is right that the builder templates plus the library cover it and that
a team starter is a nice-to-have, so my item 8 should drop below the rest.

### Where all three agreed

Nobody wants the per-minute lead tick, the team-switcher hotkey, direct agent-to-agent
configuration writes, or swarms. All three of us put an editable conversation prompt and
per-agent effort in the top half. Nobody rated his transport worth copying.
