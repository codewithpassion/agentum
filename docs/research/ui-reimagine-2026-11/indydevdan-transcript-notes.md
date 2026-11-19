# IndyDevDan small agent teams: notes from the transcript

Source: IndyDevDan, "Fable 5.2 is CRACKED but THIS goes BEYOND THE MODEL", 16 Nov 2026, 27 minutes, https://youtu.be/hYIymEMB9x4. Tiny Software Factories lesson 3.

Written 19 Nov 2026 from the full transcript, pulled with Supadata. The earlier note `docs/analysis/small-agent-teams.md` compares his mechanisms with Agentum's code. This note lists what his product shows on screen: the team features and every setting he opens. Times are minutes and seconds into the video.

## The argument

- 0:00. Two agents on the same model. The one with focused tools, focused context and a focused system prompt wins. He calls context, model, prompt and tools the core four.
- 1:11. Plain sub-agent delegation gives limited return. Swarms cost more to coordinate than they earn. The middle is a small team of specialists, each owning one kind of work, led by an orchestrator.
- 2:10 to 5:40. Model notes. He wants the strongest model as the orchestrator at medium or low effort, with workhorse or cheap models under it. He cites a five-agent team in the Fable 5.2 system card beating one agent and beating a batch of async agents.
- 6:24. Every factory starts empty so the owner can shape it. His level 3 factory has 13 features. The video covers small agent teams, the team lead, agent chat rooms, lead control and human near the loop.

## Team features he shows

| Time | Feature | What is on screen |
|---|---|---|
| 7:34 | Team selector | A hotkey opens a picker with four agents. Picking one switches the whole screen to that agent: its own chat, its own pages, its own list |
| 7:50 | Per-agent settings | Each agent has its own context, model, prompt and tools, and its own theme. The empty factory ships them as blank templates named member one, two, three |
| 9:32 | Lead agent | One agent you talk to. Its only job is to manage the team. "You talk to this one agent and your team does the work" |
| 9:50 | Team ping | The lead posts to all members in one room and each replies. Your one-to-one chat with the lead stays on the right, the room opens beside it |
| 11:01 | Agent chat rooms | The lead creates a conversation per piece of work. A sidebar lists conversations. Each can be focused on its own |
| 12:20 | Reply tags | Each agent reply carries a tag that links to the item the agent made. One click jumps to that agent's page |
| 16:02 | Sub-rooms | "Create a chat with member two" makes a room with only the lead and one member |
| 16:40 | Tracing | Every run has traces. Each tool call shows as a one-line summary, and a setting widens it to a few lines |
| 18:30 | Lead control | The lead tunes member settings, interrupts and steers. It never does the work itself |
| 18:50 | Lead tick | A durable cron job wakes the lead every minute to catch up on the team |
| 19:30 | Lead-run discussion | "Drive a three round discussion". The lead opens each round, every member posts once per round, the lead closes it |
| 20:40 | Members configure themselves | After the discussion the lead tells each member to apply the settings it asked for. They rename themselves API keeper, pipeline forge and client QA, and pick model, effort and context size. One chose a cheaper model and medium effort |
| 22:23 | Human near the loop | Cron, timers and triggers run the team without him. He steps in only when asked |
| 23:26 | Team ask | The lead queues decisions for him as a questionnaire with options per question. He can dismiss the queue and ask the lead to show it again. His answers go back in as plain text |
| 24:20 | Notification | He describes the team sending a text or Slack message when it needs answers |

## Settings he opens

Team collaboration settings (13:03):

- **Your name.** How the team addresses the person.
- **Your handle.** A unique id for the person, editable.
- **Conversations.** Open and archived conversations. The lead can archive one on request and it stays listed here.
- **Conversation prompt.** The rules for how the team talks. He calls it the social contract. It is appended to every member's prompt. The lines he reads out:
  - "You are a team member of" the team name.
  - "Prefer short concise messages."
  - "Your handle is" the agent's handle.
  - A message that mentions you asks you to respond, and you contribute from your lane.
  - A message that mentions only others: read it and stay quiet.

Every agent reads every message in the room. Only the ones mentioned reply. At 15:30 he opens a member's own chat to show it reasoning "this is addressed to lead, not me, so I'm staying quiet".

Per-agent settings (7:50, 21:00, 25:13):

- **Model.** Named slots: workhorse A, workhorse B, and a top model he calls S plus.
- **Thinking level.** Medium, high, extra high.
- **Context.** Window size, for example 200K, and a compaction setting.
- **Prompt.** A core system prompt, an agent identity prompt, then the team tools section with the person's name filled in.
- **Tools, as switches.** Coding tools, user preferences, specialised sub-agents, durable jobs, classifier model, factory control, team control. For the lead he keeps user preferences, durable jobs, factory control and team control, and turns off coding tools and sub-agents.
- **Theme and page layout.** Each agent can restyle its own screen.

## What this means for the Agentum redesign

1. **A team room with topics.** His lead opens one conversation per piece of work, sometimes with a subset of members. In Agentum a team room holds topics, and a topic maps to a Slack thread.
2. **Everyone reads, the mentioned reply.** Agentum wakes only mentioned agents and they see the last ten posts. The cheap version of his rule is a full catch-up on wake: when an agent is mentioned it reads everything since it last spoke.
3. **Editable team rules.** His conversation prompt is a setting. Ours is three fixed lines in `inbox/wake-input.ts`.
4. **You have a name and handle.** A small setting, and it is what makes mentions of a person work in a room.
5. **Lead-run rounds.** A bounded discussion with a round count. Agentum's loop guard stops wakes once the last three posts are all from agents, so it would block this. A lead-run discussion needs its own budget: N rounds, one post per member per round.
6. **Decision queue.** His team ask is several questions at once with options. Agentum has single questions with `questionKeys`. A batch card in Needs you is the gap.
7. **Per-agent effort and context budget.** Shown as plain choices, not model ids. Agentum has one model string per agent.
8. **Lead with no work tools.** A tool restriction, not a persona. The lead keeps team tools only.
9. **Lead changes members.** He lets the lead write member settings directly. Agentum should keep propose and approve, because one agent widening another's access is what `requireAgentManager` exists to stop.
10. **Reply tags.** A room post should link to the file, artifact and run behind it. Agentum stores `inboxPosts.runId` and does not show it.

What I would not take: the every-minute lead tick, per-agent themes, and members renaming and reconfiguring themselves without a person approving.
