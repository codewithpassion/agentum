# Agent teams video: research note

Written 19 Nov 2026 from documents in The Brain. Purpose: input for the Agentum UI redesign.

## Which video it is

Best match: "What RevOps should build vs. buy for the company brain (Ex-HubSpot CPO at Vector)".

- Brain document id: `6fa9aa7a-250c-4672-b0c0-8dbb4c67c5a1` (slug `doc-3737cfe27611`, path `/references/videos/day-ai`)
- Brain link: https://brain-dashboard.dominik-fretz.workers.dev/documents/6fa9aa7a-250c-4672-b0c0-8dbb4c67c5a1
- Channel: Day AI
- URL: https://www.youtube.com/watch?v=0phAfVzaAw4
- Saved to the Brain: 9 Nov 2026. The transcript gives no publish date.
- Length: about 32 minutes. It is a conference talk to a RevOps audience, and "Vector" in the title looks like the host or event.
- Speaker: the transcript never states his name. He describes himself as a former HubSpot chief product officer who spent 10 years there and left in 2021, and who now runs the company behind the Day AI channel. That profile fits Christopher O'Donnell, but this is my inference, so check the video page before quoting a name.

Confidence that this is the video Dom means: medium to high, about 75 percent. It is the only document in the Brain that says agents should have a human manager who takes credit through the org chart, and it was saved 10 days before this note. One thing does not fit: the talk never mentions Microsoft. The speaker is ex-HubSpot. I searched for Microsoft, Copilot, "agent boss", "digital employees", and human owner wording across the Brain, and listed every reference saved since 25 Oct 2026. Nothing from Microsoft covers this topic. The only Microsoft items are an X post about the Copilot harness in Foundry (`877e7715-5318-44c6-aa9f-588dc4a0ee34`) and a Better Stack video on token use. If Dom is sure the speaker was from Microsoft, the video may not be in the Brain.

The talk shows no product UI. The transcript refers to slides (a before and after comparison, two charts, a build versus buy list) but no demo. Every UI idea below is my reading of the concepts, not something shown on screen.

## Summary of the talk, by theme

### Agents and the human org chart (the core idea)

- [22:46 to 23:50] People should have agents they "form a relationship with", and more than one. His example is a sales team that runs a coach agent, a research agent that finds leads and drafts emails, and a data entry or reporting agent ("prep me for my forecast meeting"). The transcript calls this the "GroqBot" sales team. He admits the setup is held together with duct tape but calls it "extremely right".
- [23:50] Why it is right: each agent is "a long-lived entity that the human can give feedback to", and each has "a defined job role" that the human who manages it "can take credit for".
- [23:50] He calls this "a really important concept". If productivity and credit cannot "accrue through that human org chart", deployment gets awkward, because the business keeps score: who is productive, who closes deals, who has capacity in the financial plan.
- Reading for Agentum: an agent sits under a named person. Its output counts as that person's output. The agent does not get its own box as a peer in the org chart. It hangs off a human, and its results roll up to that human and their team.

### Ownership, control, and visibility

- [31:05] His third takeaway is a whiteboard exercise: "who has control of what? Who can see what?" For agents and skills that run in the background, "who owns that?"
- [31:05 to 32:06] He says most teams have a weak answer, such as pushing skills out and telling people to paste them into Claude. Anyone who gives a very good answer to the ownership question deserves promotion.
- [08:17 to 09:19] Every person and team already has a private "rig" or harness. Many are not in version control and only the owner knows about them. Sharing a folder through GitHub gives no permissioning on what is inside.
- [09:19] One folder takes precedence over all the others: the one about how the company makes money. That gives the central strategy authority over individual rigs.

### Long-lived agents with names and job roles

- [17:35 to 18:38] He dislikes single "mono-agent" bots that everyone asks questions of. He jokes that they are all named Jarvis.
- [20:40] The third "before" problem is the "faceless void": no names, no personality, and no way for the agent to confirm a standing request such as "you want this in this format every Tuesday". He says a faceless tool is fine in engineering and not good enough in go-to-market work.
- [23:50] The "after" is several named agents per person, each with one job: coach, research, reporting.
- Reading for Agentum: agents need an identity (name, role, manager) and need to acknowledge and keep standing commitments. A recurring instruction should show up as a visible commitment of that agent.

### Proactive work instead of bot-sitting

- [18:38 to 19:40] "Before" problem one: humans are "bot-sitting". They type into a chat so the model can enter data elsewhere, which is slower than doing it by hand. Running 20 such threads causes fatigue and burnout.
- [19:40 to 20:40] "Before" problem two: work is "ad hoc and ephemeral". It happens in a thread because someone thought of it, then it is gone. The next person who needs the same verified report starts from zero.
- [20:40 to 21:42] "After": the intelligence is proactive. His example is a daily brief that tells him the one thing about the business that would surprise a CRO. He set it up by telling his agent once, during a call.
- Reading for Agentum: the home screen should show what agents did and found without being asked, not an empty chat box. Scheduled briefs are a first-class output.

### Feedback loops and self-improvement

- [13:26] His engineering rig "improves itself". The company pays for tokens and people to solve a problem once, and it stays solved.
- [19:40 to 20:40] In engineering, an afternoon spent debugging benefits everyone the next time. Knowledge in the harness compounds.
- [21:42 to 22:46] The go-to-market version: document what works in a vertical or deal type, and what helps reps ramp faster. Keep it in one place, let everybody's agents pull from it to coach people, and update it as information arrives.
- [22:46] Engineering already runs loops that find bugs and fix them, so the product improves around the clock while people decide "how hot to run the system".
- [31:05] Getting from baseline to 2x is the hard part. After that, these systems "tend towards self-improvement".
- Reading for Agentum: feedback given to an agent should land in durable shared knowledge, and the UI should show what an agent learned and from whom. A spend or intensity control ("how hot") is a product feature.

### Teams of agents and the control plane

- [28:01] He names the "agent control plane" as its own build or buy decision. The need: push a behaviour change across everyone's agents (his example: a new product, so every agent should look for attach opportunities) while people keep their personal setup.
- [28:01] Options he lists: guardrails, a required MCP server, a set of instructions every agent must include.
- [25:55 to 26:58] Company strategy should be pushed out so that everyone's behaviour ladders up to it.
- Reading for Agentum: two layers of instruction. An org layer that an admin pushes to all agents, and a personal layer the owner controls. The UI should show which instructions an agent inherited and which are its own.

### Memory and data sources

- [10:20 to 11:23] A company brain is a folder: strategy documents, sales process, meeting notes, the "big hills" the company has to climb. You open an agent in that folder and talk to it.
- [16:33] Recall is now expected. Meeting recorders capture everything, so people can pay attention in the meeting.
- [25:55 to 26:58] Meeting transcripts are "gold". When he whiteboards with practitioners, the traditional CRM never makes the top five data sources. It is "low resolution". Meeting recordings, Granola notes, customer Slack, and email rank higher.
- [26:58 to 28:01] Put the sources in one place for instant recall. Privacy and permissioning (for example Gmail) are unsolved for most teams.
- [29:01] Knowledge management is an open choice: Markdown files, Glean, Notion.

### Governance and measurement

- [11:23 to 12:26] Pick the number that defines success for the AI strategy, such as ramp time from seven months to four. He has never met a RevOps leader who has one. "You cannot improve what you can't measure."
- [30:03] Ask what slide the team's AI champion would show the CEO in six months.
- [17:35] Record keeping should be automatic, with clean data and "full governance" held by the ops team.
- [31:05] Governance comes down to the control and visibility question above.

### What stays with humans

- [15:31] The human rep stays as the credible representative who makes promises and stands behind them. He agrees that buyers do not want to buy from AI.
- [15:31 to 17:35] Research, recall, and record keeping go to agents.

### Work surface

- [28:01 to 29:01] He treats the work surface as an open question. People now vibe-code their own UIs, and he finds it hard to tell them not to, even though his company builds UI for a living.
- Reading for Agentum: expect users to want their own views. Stable data and actions behind the UI matter more than one fixed layout.

### Concrete product features described or implied

1. Several named, long-lived agents per person, each with one job role.
2. A human manager per agent, with credit and productivity rolling up through the org chart.
3. Feedback from the manager to the agent that persists.
4. Standing commitments the agent confirms ("every Tuesday, in this format").
5. Proactive scheduled briefs, such as the daily surprise report.
6. A shared knowledge base that all agents read and that is updated as work happens.
7. A control plane that pushes skills and instructions to everyone's agents while keeping personal settings.
8. A clear view of who controls and who can see each agent and skill.
9. A success metric tied to the financial plan.
10. A control for how hard to run the system, meaning spend.

## Other documents checked

### 7e309377-93ee-4aab-a44f-e4247af7c783: "How the Pros Actually Work With AI Now" (Matt Maher, YouTube)

Slug `doc-56b04e8b51ed`. Not the agent teams video, but relevant. I read the matching passages, not the full transcript.

- [03:02 to 06:04] The "director pattern": the human talks to one director agent. The director does not do the work. It stays available, splits requests, starts sub-agents in roles, picks a model size per task, and reports back while they run.
- [11:09 to 12:10] Roles are not a fixed workflow. The system writes new roles when it sees the same kind of work repeat.
- [20:20 to 22:22] He spends much of his time "strengthening the relationship" with the director by stating rules and expectations. When the director gathers too many rules, he tells it to split them into roles. He says built-in memory will not keep per-role expectations as the system grows, so they belong in role files.
- UI idea: one conversational front door per human, a live list of background tasks with counts, and role definitions as editable objects.

### 082a7ee6-4463-4f7d-aa9b-259bfe73a7e6: "Podcast - Google Meet transcript" (22 Sep 2025)

Slug `doc-07d12c3492a7`. Not relevant. It is a planning call between Dom and Sean Irvine about naming their podcast. "Real Work AI and the Human Team" is the working title they chose. It has no content on agent platforms.

### Smaller related items

- `63878e02-15db-45b7-b72f-c90344c99701`, "How to Build a Software Factory That Improves Itself" (Zach Lloyd, Warp, AI Engineer). [03:06] Every company will run a cloud loop where humans put work in and agents do triage, spec, build, and verification. The business defines the rules for how humans and agents interact, then measures and improves.
- `0ddf659e-6ee0-4093-aac2-1d78f15429e5`, "durable agents are actually important" (Jaymin West). [12:14] He moves from "agent skills" to "skilled agents": agents that hold one role for weeks or months, know one system deeply, and escalate anomalies to humans on the team.
- `2aba0a3b-2ac6-4ec0-8609-70f8c1a7fcc8`, "OpenAI and Anthropic Agree on What Comes After Loops" (Ray Amjad). [15:43] Agents work well when they call other agents like tools, and badly as peers with no hierarchy. The next step he reports is long-running leads (programming, design, QA) that work for weeks with workers under them. [19:56] A counterpoint: when he gave agents personas, they built bureaucracy and stalled.
- `b6ea4ba7-4742-40da-be4e-da42f4fd8f82`, "Anthropic's New Subagent Rules Will Change How You Build" (Ray Amjad). [04:02] "Subagent sprawl": every team ships its own agent, and companies end up with hundreds of overlapping agents with "no single owner". This supports an agent registry with an owner field.
- `89d2cdb9-0028-4c3a-9e37-3afd5b970ea6`, "Who Is Making This Request? Agent Auth 101" (Kamil Potrec, Keycard). [08:07] Agents need their own identities, separate from whoever launched them, plus explicit delegation that states which users an agent may act for, and short-lived scoped credentials.
- `5114374b-8510-44f5-9291-9bf0a7923623`, "The state of the software engineering industry" (Gergely Orosz, LeadDev). [20:16] Teams stay the unit of work. He reports that at Anthropic and OpenAI, human teams still own software and on-call, with each person supercharged by AI. He rejects the "two humans and a bunch of agents" picture.
- `02dffc41-16bb-45a4-b7f7-31f2795c8779`, meeting "Chale" (23 Sep 2026). Chale Dodge pitched an agent workforce mapped to an org role taxonomy. Dom pushed back on replacing roles one for one and they settled on an assistant that works beside existing staff. This matches the direction of the Day AI talk.
- `b96f4285-30ae-45be-af62-fab48c1e3cb9`, Chris Rickard LinkedIn post (5 Nov 2026). A list of what AI-heavy teams build: software factory, chief of staff agent, security officer agent, company brain, collaborative agents in Slack or Teams, verification loops.

## Search coverage

I read the full Day AI transcript, the full podcast planning transcript, and the full Chris Rickard post. For the other documents I read search passages only. I listed all Brain documents created from 25 Oct to 18 Nov 2026 and scanned the titles of references and meetings.
