# UI reimagine research, November 2026

Written 19 Nov 2026. Dom asked for a fresh look at how Agentum's UI could work, ignoring the current layout. Nothing here is built.

Start with `report.html`. It holds the comparison of other platforms, three UI proposals (Roster, Rooms, Jobs), the feature gap map and a build order.

| File | Contents |
|---|---|
| `report.html` | The report: findings, three proposals with wireframes, gap map, build order, open questions |
| `agentum-inventory.md` | What Agentum has today: capabilities with state and code paths, routes, flows, friction points, data model |
| `hermes-agent.md` | Hermes Agent (Nous Research), v0.23 |
| `openclaw.md` | OpenClaw Control UI and team features |
| `manus.md` | Manus |
| `platform-survey.md` | Microsoft, Anthropic, OpenAI, Google and ten teammate products, with patterns and trends |
| `agent-teams-video.md` | The Day AI talk from The Brain, plus related Brain documents |
| `indydevdan-transcript-notes.md` | Team features and settings from the full IndyDevDan transcript, with times |
| `memory-and-dreaming.md` | Design note: remember rules, memory scopes, the dream, the team dream |

The IndyDevDan small agent teams analysis is in `docs/analysis/small-agent-teams.md`.

Dom accepted the recommendation on 19 Nov: the Roster as the shell, with the team room from Rooms (linked to a Slack channel) and the job sentence from Jobs. He also asked for agent memory with rules for what to remember and a scheduled dream, including a team dream. The second version of the report covers both. 

Decisions on 19 Nov, also listed at the end of the report: the name is "team room"; one Slack app per agent, and one Slack channel maps to one team room; a room message that names nobody goes to the lead; notes default to "Tell me after" and skill changes always ask; memory is files in the agent's library folder; dreams are built into Agentum, with code copied from The Brain where useful and no call to it as a service. Four questions are still open: dreams reading private conversations, a lead changing its members, wording on agent cards, and agents in two teams.

The report is also published as an Agentum artifact in the Harbour Edge workspace: https://agentumbot.io/a/8aa75f3b-9d58-4cc2-ba36-b2301b41c6e8 (version 2, which does not yet list these decisions).
