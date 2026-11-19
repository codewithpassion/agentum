# Agent platform survey for the Agentum UI redesign

Researched 19 Nov 2026. This survey covers product concepts and UI layout, not model quality. Hermes Agent, Manus and OpenClaw are left out because other surveys cover them.

How to read the confidence marks. "Verified" means I read the vendor's own page on 19 Nov 2026. "Secondary" means the claim comes from press or third-party write-ups. "Unverified" means I could not confirm it this session. openai.com returned HTTP 403 to every fetch, so all OpenAI material is secondary or from background knowledge.

## Part 1. The big four

### Microsoft

Microsoft splits the problem into a builder, a control plane and an identity system. Copilot Studio is the builder. Microsoft rebuilt it at Build in June 2026, with child agents folded into "skills" and "connected agents" (secondary). It has autonomous triggers, agent flows with approval gates, and a computer use tool. Agent 365 is the control plane, generally available since 1 May 2026. Its docs call it "the observability platform for AI" and name four pillars: management, governance, security and business value. Admins get an agent registry that shows owner, usage and risk per agent, an Agent Map that groups agents by the platform they were built on, and a cost view that breaks Copilot Credits down by user, group and agent (verified).

Entra Agent ID is the most copied idea. Each agent gets its own identity and at least one human sponsor, "the business representative accountable for the agent's purpose and lifecycle". An agent can also get its own user account with a mailbox, OneDrive and Teams presence, and people can reach it "through Teams, Outlook, Word comments, and email". That last part is still limited to the Frontier preview program (verified). Docs describe three run modes: as itself, on behalf of a user, or as its own user account.

The story on top is the "Frontier Firm" from the 2025 Work Trend Index, where every employee becomes an "agent boss" who "builds, delegates to and manages agents". Only 844 of 31,000 surveyed workers sat in firms that fit the description, so treat it as a sales story. I found no coverage of Ignite 2026 (unverified).

Sources: [Agent 365 overview](https://learn.microsoft.com/en-us/microsoft-agent-365/overview), [Agent 365 identity](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/identity), [Work Trend Index 2025](https://blogs.microsoft.com/blog/2025/04/23/the-2025-annual-work-trend-index-the-frontier-firm-is-born/), [Copilot Studio rebuild](https://holgerimbery.blog/copilot-studio-orchestration-part3), [Agent boss coverage](https://virtualizationreview.com/Articles/2025/04/23/2025-Work-Index-All-Employees-Will-Be-Agent-Bosses.aspx).

### Anthropic

Anthropic's unit is the task, not a named agent. In the Claude apps, chat and Cowork now share one home. You pick "Cowork" in the message box, "describe an outcome, step away, and come back to finished work". Sessions run in an isolated cloud environment and keep going when the laptop closes. The app shows step by step progress, lets you steer mid-task, and lists work under Tasks and a "Scheduled" sidebar item. Projects are persistent workspaces with their own files, instructions and memory. Three approval modes sit in a selector: Manual, Auto with an automated safety check, and Skip. Each connector tool has its own setting, from "Always allow" to "Blocked". Plugins bundle skills, connectors and sub-agents (verified).

Claude Managed Agents is the developer version, still in beta. It has four concepts: agent, environment, session and events. It adds persistent file systems, cron schedules, memory stores and "dreams". A dream is a batch job that reads past session transcripts and writes a cleaned memory store. The input store stays untouched so a person can review the result and discard it (verified, research preview).

Claude Code agent teams are experimental. One session is the lead. Teammates each have their own context, share a task list with pending, in progress and completed states, and message each other through a mailbox. The docs recommend 3 to 5 teammates. Teammates cannot spawn their own teams, and permission prompts go up to the lead (verified).

Claude Tag replaced Claude in Slack in August 2026. One shared @Claude works under its own organisation identity, keeps channel-scoped memory, posts a checklist in the thread, and has spend caps with alerts at 75% and 95% (secondary).

Sources: [Getting started with Cowork](https://support.claude.com/en/articles/13345190-getting-started-with-cowork), [Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview), [Dreams](https://platform.claude.com/docs/en/managed-agents/dreams), [Agent teams](https://code.claude.com/docs/en/agent-teams), [Claude Tag](https://www.datacamp.com/blog/claude-tag).

### OpenAI

All OpenAI claims here are secondary because openai.com blocked my fetches.

Workspace agents launched in ChatGPT on 22 April 2026 as a research preview for Business, Enterprise and Edu plans. Press describes them as the successor to custom GPTs. Each agent runs on the Codex cloud base with its own workspace, can write and run code, use connected apps and keep memory. The UI centres on an Agents tab in the ChatGPT sidebar. That tab doubles as a directory where "agents built by coworkers can be reused across a workspace". Builders start from templates. Agents run on schedules, or sit in Slack where an agent "listens for mentions and threads its work back in". Write actions such as sending email default to "Always ask", and the builder can loosen that per action. A dashboard shows total runs, unique users and a feed of recent runs. Admins set who may browse, run, build and publish, and choose whether an agent signs in as the end user or with agent-owned accounts. Pricing moved to credits in May 2026.

AgentKit, from October 2025, is the developer kit. Agent Builder is a drag and drop canvas of nodes, with ChatKit and a connector registry beside it. I found no 2026 status update for it. One page dated September 2026 describes an Agents API for cloud agents on the Codex base (unverified).

From background knowledge, not rechecked: ChatGPT agent, launched July 2025, showed a live view of a virtual computer and let the user take over the browser. ChatGPT Tasks, from January 2025, added scheduled prompts. The Codex app lists parallel cloud tasks and treats skills and automations as its two main concepts.

Sources: [VentureBeat on workspace agents](https://venturebeat.com/orchestration/openai-unveils-workspace-agents-a-successor-to-custom-gpts-for-enterprises-that-can-plug-directly-into-slack-salesforce-and-more), [OpenAI announcement, blocked](https://openai.com/index/introducing-workspace-agents-in-chatgpt/), [AgentKit coverage](https://thenewstack.io/openai-launches-a-no-code-agent-builder/), [Codex app case study](https://zenml.io/llmops-database/building-and-deploying-the-codex-app-a-multi-agent-ai-development-environment).

### Google

Google relaunched Gemini Enterprise at Cloud Next on 23 April 2026 as three parts: the Agent Platform for developers, the Gemini Enterprise app for staff, and a partner catalogue. Agentspace is the older name for the app.

In the app, Agent Designer is the no-code builder. "Anyone can create agents" from natural language or a visual flow, and agents can run on a schedule or a trigger. The Agent Gallery is the catalogue. It has three shelves: Google's agents, agents your organisation added, and your own. It also has a "request-and-approval gateway" so a staff member can ask IT for a partner agent. The piece most relevant to Agentum is Inbox, "a unified hub for managing agents at scale, including long-running agents". It lets users monitor agents, change settings and get status alerts by email and chat. Projects are "a shared workspace for teams and agents" that keeps context and history. Canvas is a side editor for Docs and Slides (verified).

On the platform side, Agent Identity "assigns every agent a unique cryptographic ID", Agent Gateway polices agent traffic, Memory Bank holds long-term memory, and Agent Simulation tests agents before release. Google backs both A2A and MCP (verified).

Jules is Google's cloud coding agent. It works from a plan the user approves, though plans can auto-approve after a wait. It gained memory of user corrections and scheduled tasks in late 2025 and early 2026 (secondary). I found no link between Jules and the Gemini Enterprise gallery.

Sources: [The new Gemini Enterprise](https://cloud.google.com/blog/products/ai-machine-learning/the-new-gemini-enterprise-one-platform-for-agent-development), [Agents gallery docs](https://cloud.google.com/gemini/enterprise/docs/agents-gallery), [Agent Designer docs](https://cloud.google.com/agentspace/agentspace-enterprise/docs/agent-designer), [Jules scheduled jobs](https://www.testingcatalog.com/google-to-add-scheduled-jobs-and-proactive-mode-to-jules-agent), [Jules review](https://rywalker.com/research/jules).

## Part 2. Agent-as-teammate products

I picked ten. Glean agents, n8n agents, Factory, CrewAI and Gumloop are left out because I did not verify their current UI this session. Cursor gets a short note under Devin.

### Lindy

Lindy is the clearest case of a product that moved away from a builder. It began as a no-code agent builder with flow diagrams. In February 2026 it relaunched as a personal work assistant (secondary). Its own site now sells "an AI employee for your whole team". You hire one Lindy, connect your tools, and it learns how the business runs. Staff reach it through Slack, iMessage, email and the browser. Memory is shared across the team and grows over time, while each person's direct messages stay private. Actions that write or send data can wait for a person's approval. Where no integration exists, Lindy drives a browser "like a person would". Billing is per user with a shared team credit pool (verified from Lindy's own summary page).

The lesson for Agentum is the direction of travel. Lindy's users did not want to draw flows. They wanted one named helper they could message from the channels they already use. A reviewer notes that permissions for shared team inboxes are still immature, which is the cost of one shared agent with shared memory.

Sources: [Lindy summary](https://lindy.ai/llms.txt), [Lindy assistant launch](https://www.lindy.ai/blog/lindy-assistant-launch), [Lindy review](https://www.wearefounders.uk/lindy-ai-review-2026-is-it-worth-it-for-solo-founders/), [Lindy research note](https://rywalker.com/research/lindy).

### Relevance AI

Relevance AI sells an "AI workforce". Its Workforce product, launched May 2025, is a visual canvas where you place agents and draw how work passes between them. The docs define two kinds of link. An "AI connection" lets the sending agent decide when to hand over. A "next step" always fires when the previous agent finishes. A workforce can include human approval steps, and one agent can belong to several workforces. A separate tool called Invent builds an agent from a text description (verified from docs, launch details secondary).

This is the canvas pattern applied to teams instead of steps. It makes the team structure visible, and it gives a builder a clear place to add a human check. The weakness is the same as any canvas. Someone has to design the hand-offs up front, and a non-technical owner of a ten person company rarely thinks in diagrams. I found no dated 2026 redesign, so the current UI may differ (unverified).

Sources: [Workforce docs](https://relevanceai.com/docs/get-started/core-concepts/workforces), [Workforce launch post](https://relevanceai.com/blog/introducing-workforce-the-visual-canvas-for-building-ai-teams), [Workforce product page](https://relevanceai.com/workforce).

### Sierra

Sierra builds customer service agents for large companies, so its buyers differ from Agentum's. Its builder design is still worth study. In March 2026 Sierra introduced Ghostwriter, "an agent that creates and optimizes other agents". On 2 November 2026 it rebuilt Agent Studio around Ghostwriter. A user can ask why the resolution rate dropped, look at the conversations, change a journey and test the fix inside one conversation. Evidence, proposed changes and test results stay together so a team can review them before release. Ghostwriter stays present as the user moves between journeys, simulations and dashboards, and it sees what is open. Related agents can sit in one project with shared data and channels. Since September 2026 Ghostwriter also works as a teammate in Slack and Teams that reviews customer conversations and suggests improvements (secondary, based on Sierra's own blog).

The idea to take is that the builder is itself an agent with the whole workspace in view. Editing an agent becomes a conversation that ends in a reviewable change, with a test run attached. That is "describe to create" extended to "describe to fix".

Sources: [Agent Studio](https://sierra.ai/product/agent-studio), [Redesigning Agent Studio around Ghostwriter](https://sierra.ai/blog/redesigning-agent-studio-around-ghostwriter), [Unite.AI coverage](https://www.unite.ai/sierra-puts-ghostwriter-at-the-center-of-agent-studio-workflows/).

### Dust

Dust is the closest match to Agentum's audience, though it sells to larger firms. It calls itself "multiplayer". Staff @mention named agents inside shared conversations, and several agents can work in one thread. Agents have skills, tools and triggers that fire on a schedule or an outside event. Memory is a tool a builder adds to an agent. It stores facts per user, and each user can read and delete them in the agent's Memory tab (secondary).

Pods arrived in August 2026. A Pod is a shared workspace that holds conversations and tasks. Tasks are work items that "humans or agents can create, assign, start an agent on, and close". Dust states the design rule plainly: everything a human can do, an agent can do. Pods are open or invite-only (verified from docs).

Dust shows two things. A memory view the user can edit builds trust cheaply. And a small task list inside a shared room gives people a way to hand work to agents without leaving the conversation. Its count of 300,000 deployed agents has no definition of "active", so ignore it.

Sources: [Pods overview](https://docs.dust.tt/docs/pods-overview), [Dust memory changelog](https://docs.dust.tt/changelog/dust-global-agent-now-uses-memory), [tech.eu on Dust Series B](https://tech.eu/2026/05/18/dust-raises-40m-series-b-to-build-the-multiplayer-operating-system-for-enterprise-ai/).

### Notion custom agents

Notion has two agent types. Notion Agent is a personal helper that acts with the user's own permissions. Custom Agents are "team-wide AI teammates that run automatically on schedules or triggers". You create one by describing it, "and Notion AI builds your agent for you", or from a template. Triggers include schedules, Slack mentions and emoji reactions, new mail from a sender, calendar changes and database changes. "Each Custom Agent gets its own permissions, just like a teammate", set per page. Every run is logged "showing what triggered it, what it did, and why", and page version history makes changes reversible. Each member gets monthly credits. An agent spends its owner's credits unless an admin gives it its own monthly budget, with alerts at 80% and 100%. Agents pause when credits run out (verified).

Two points stand out. The personal versus team split is easy for users to grasp because it maps to whose permissions apply. And the run log answers the three questions a non-technical owner asks, which are why it ran, what it did and why it did that. The page says nothing about agents working as a team.

Sources: [Notion Agents](https://www.notion.com/product/agents), [Custom Agent pricing](https://www.notion.com/help/custom-agent-pricing).

### Slack

Slack's position is that it is the place where agents work, whoever built them. In March 2026 it relaunched Slackbot as a personal agent for every employee. In April 2026 it described agents as "integrated teammates that work where your team already collaborates". Slackbot is the front door. A user states a need, and Slackbot routes it to a specialist agent and coordinates multi-step work. Agents post results in channels and threads. An agent browser under Tools > Agents lists a vetted directory called AgentExchange, the user's active agents and recent conversations. Third-party agents such as Claude, Cursor, Notion and Linear plug in. Governance covers the vetted directory, exclusion controls, permission sync and audit logs (verified from Slack's blog).

For Agentum this matters twice. Slack is a channel Agentum agents already live in, and Slack is turning into a router that sits in front of them. A user may soon ask Slackbot, not the Agentum agent. The pattern also shows the limit of channel-based agents. Slack gives presence and conversation, but no good place to see an agent's memory, files, schedule or spend. Those still need a home elsewhere.

Sources: [Slack is where agents work](https://slack.com/blog/news/slack-is-where-agents-work), [Meet Slackbot](https://slack.com/blog/news/slackbot-context-aware-ai-agent-for-work), [Agent-first workspace](https://slack.com/blog/news/agent-first-workspace-slack).

### Zapier Agents

Zapier rebuilt Agents around two views. Pods group agents by function, such as "Sales Operations". The Activity dashboard logs every run with its status, the apps it used and when it ran. It works at three levels: all agents, one pod, one agent. Agents that need input are flagged, and a "Needs action" filter finds them. More than 20 templates ship with it, and a prompt assistant helps draft instructions. Zapier's post says it reduced the role of chat on purpose, to favour building and watching autonomous agents. Agent-to-agent calling is described only as a future step (verified from Zapier's blog, no date on the page).

Zapier came from the workflow side and chose a monitoring view over a chat view. That fits its users, who set an agent up once and want to know it is still working. The "Needs action" filter is the simplest form of a needs-you queue. Pods are a flat grouping with no hierarchy, which may be all a small company needs.

Sources: [Zapier Agents pods and dashboards](https://www.zapier.com/blog/zapier-agents-pods-dashboards), [Agent templates](https://zapier.com/agents/templates), [Organise agents in pods](https://help.zapier.com/hc/en-us/sections/33250054078477-Manage-agents).

### Devin, with a note on Cursor

Devin is a coding agent, but its product shape has spread to other fields. The unit is the session. Each session runs in its own virtual machine with a live view of the editor, shell and browser. Around sessions sit three reusable things: Knowledge entries that Devin suggests and a person approves, Playbooks that are shared prompt templates, and schedules for recurring sessions. "Managed Devins" let a coordinator session split a large job across child sessions, watch progress and merge results. People start work from Slack or the web app. Release notes from 2026 mention session folders in the sidebar and Slack direct messages with automation Devins (secondary, from docs index and release notes).

Cursor reached a similar place. Its background agents became cloud agents, started from the desktop app, the web, iOS, Slack, Linear or GitHub. Cursor 3 added an Agents Window for running many agents in parallel, and Automations for event-triggered agents (secondary, dates differ across sources).

The pattern is a list of parallel sessions with status, a live view for anyone who wants detail, and a coordinator that spawns children. Knowledge that the agent proposes and a human approves is a self-improvement loop a small business owner can follow.

Sources: [Devin release notes](https://docs.devin.ai/release-notes/overview), [How Cognition uses Devin](https://cognition.com/blog/how-cognition-uses-devin-to-build-devin), [Cursor cloud agents](https://cursor.com/blog/cloud-agents), [Cursor 3 Agents Window guide](https://www.digitalapplied.com/blog/cursor-3-agents-window-complete-guide).

### Linear

Linear has the most careful answer to "who is accountable". Agents appear as members in the assignee menu, and admins choose which teams can use each one. Assigning an issue to an agent sets it as the delegate. The human stays the assignee, because in Linear's words an agent cannot be held accountable. You can also @mention an agent in a comment. Each mention or delegation opens an agent session with a visible state: working, waiting for input, error or done. Guidance for agents is markdown at workspace and team level, and team guidance wins. People track agent work through agent user pages, views filtered by delegate, and Insights. Agents do not use paid seats and cannot sign in or reach admin functions (verified from docs). Linear also published Agent Interaction Guidelines in July 2025, which say an agent must disclose that it is an agent.

The delegate field is a small design choice with a large effect. Every piece of agent work has one named human on it, and reports can show how much work goes to agents. For Agentum, an existing task tracker where agents are assignable is a strong alternative to building a separate agent dashboard.

Sources: [Agents in Linear](https://linear.app/docs/agents-in-linear), [Assign and delegate issues](https://linear.app/docs/assigning-issues), [Agent Interaction Guidelines](https://linear.app/developers/aig), [Agent best practices](https://linear.app/developers/agent-best-practices).

### Paperclip

Paperclip exists. It is an open-source, MIT-licensed, self-hosted Node.js server with a React UI at `paperclipai/paperclip`. Its README says, "If OpenClaw is an employee, Paperclip is the company." You set a company goal, hire agents, approve the strategy and set budgets. Agents have roles, titles, reporting lines and job descriptions on an org chart. Work lives in tasks with comments, plans, blockers, files and run history, and tasks link back to company goals. Agents wake on "heartbeats" when they have assigned work, a message or a timer. Budgets exist per company, agent and project, with alerts, and work pauses at the limit. Approval stages can gate hires and task completion, and config changes keep revisions. It runs other agents instead of its own, including Claude Code, Codex, Cursor, Gemini CLI, OpenClaw and Hermes. One install can host several companies (verified from README). I could not confirm its star count or how many people use it.

Paperclip is the fullest version of the org chart idea, and its UI still "looks like a task manager". That is telling. Even the product built around a company of agents puts tasks, not the chart, in the main view. Dom's own notes say Agentum v2 dropped the org chart, and Paperclip's layout supports that call.

Sources: [Paperclip README](https://cdn.jsdelivr.net/gh/paperclipai/paperclip@master/README.md), [Paperclip docs](https://paperclip.ing/docs), [Better Stack guide](https://betterstack.com/community/guides/ai/paperclip-multi-agent/).

## Part 3. Synthesis

### Recurring UI patterns

**Agent as teammate with a profile.** Microsoft gives agents a people card, mailbox and place in the directory. Linear lists them in the assignee menu. Notion gives each one its own permissions. Lindy and Claude Tag sell one named helper. This works for non-technical users because they already know how to deal with a colleague: message them, give them access, check their work. It fails when the profile is a costume. If the "teammate" forgets last week or cannot be reached by email, the metaphor breaks and trust drops with it.

**Needs-you queue.** Google's Inbox, Zapier's "Needs action" filter, Linear's "waiting for input" state and Claude's approval prompts all answer one question, which is what needs me right now. This is the highest-value view for a busy owner. It fails when every small step lands in it. Anthropic's docs admit that teammate permission prompts "can create friction", and the fix is to pre-approve common actions.

**Task list or board.** Paperclip, Dust Pods, Linear, Claude Code teams and the Cowork task list all use it. It works because a task has a state and an owner, and people can scan it. It handles long work better than chat does. It fails for quick questions, where opening a task feels heavy.

**Chat-first.** Claude, ChatGPT, Lindy and Slackbot. Anyone can start, with no training. It is weak for work that runs for hours, because the result sinks in a thread and nobody can see what five agents are doing at once. Zapier cut chat back for that reason.

**Canvas or flow builder.** Relevance AI Workforce, OpenAI Agent Builder, Copilot Studio flows, and Google Agent Designer's visual mode. It gives exact control and a clear spot for approval steps. Most business users will not draw one. Lindy left this model, and Google and Notion both lead with plain language and keep the canvas as a second option.

**Org chart.** Paperclip, and Microsoft's directory for agent users. It reads well in a demo. In daily use people look at tasks, and a chart of six agents adds little. It becomes useful as a permissions and budget tree, less as a home screen.

**Channel-based agents.** Claude Tag, Slack agents, Teams, workspace agents in Slack, Devin, Cursor. No new app to learn, and the agent's work is visible to the team. The gaps are privacy in shared channels, noise, and no place to manage memory, files or spend. Claude Tag splits tools into a shared channel identity and a personal one in direct messages to deal with the first gap.

**Live computer view.** ChatGPT agent, Devin, Lindy's browser use, Copilot Studio computer use. Watching an agent click through a site builds trust in the first week. After that nobody watches. Keep it as an optional detail view and a replay for audits.

**Describe to create.** Notion, Google Agent Designer, Relevance Invent, Sierra Ghostwriter, Zapier's prompt assistant, Claude Code teams. This is now the default way to make an agent. It fails when the result is a black box. Sierra's answer is to show the proposed change and a test run before release.

**Templates gallery.** Google Agent Gallery, Zapier, Notion, ChatGPT's Agents tab, Slack AgentExchange. Good for a first agent and for showing what is possible. A long gallery of near-identical templates hides the two that matter. Google shows four per shelf.

**Approvals.** ChatGPT workspace agents default write actions to "Always ask". Claude has three modes plus per-tool settings. Lindy holds writes and sends. Linear and Paperclip gate at task level. Per-action defaults that the owner can relax are the pattern that works. Claude's Auto mode, where a second check reviews each action, points to fewer prompts without giving up safety. Claude Tag's ambient mode has no approval step, and commentators flagged that.

**Activity feed and audit.** Notion logs what triggered a run, what it did and why. Zapier, ChatGPT, Agent 365 and Slack all keep run logs. Owners need this in plain words. Raw tool call logs help developers and nobody else.

**Memory viewer.** Dust has a Memory tab per agent. Claude Tag lets admins view, edit and delete channel memory. Claude's dreams produce a new store for review before use. Devin proposes knowledge for approval. A visible, editable memory is the cheapest trust feature in this list. It fails if the list grows to hundreds of unsorted facts.

**Skills library.** Claude skills and plugins, Copilot Studio skills, Codex skills, Devin playbooks. A skill is a reusable way of doing a job that any agent can load. Users understand "teach it once, share it with the team". Naming is the risk, since skills, tools, connectors and plugins blur together.

**Cost and usage display.** Agent 365 shows credits by user and agent with limits. Notion and Claude Tag alert at set thresholds and pause. Paperclip budgets per agent. Small companies care about this more than large ones. A monthly cap per agent with a pause is easier to grasp than tokens.

### Where it is heading

1. **Agents get their own identity, mailbox and credentials.** Microsoft's agent user accounts, Google's cryptographic agent IDs, Claude Tag's organisation identity and OpenAI's "agent-owned accounts" all point the same way. The agent stops borrowing a person's login. Expect "which account does this agent act as" to become a standard setup question.

2. **Every agent has a named human owner.** Microsoft requires a sponsor. Linear keeps the human as assignee and the agent as delegate. Agent 365 hunts for agents that lost their owner. Accountability is moving from policy into the data model.

3. **People become managers of agents.** Microsoft's "agent boss" is the slogan. Google's Inbox, Zapier's dashboard and Cursor's Agents Window are the tools. The daily job shifts from prompting to assigning, reviewing and unblocking.

4. **Teams with a lead replace single agents for big jobs.** Claude Code has a lead and teammates, Devin has a coordinator and children, Slackbot routes to specialists, Copilot Studio has connected agents. All keep the tree shallow. Claude Code forbids nested teams and suggests 3 to 5 members.

5. **Agents improve between runs, with a human check.** Claude's dreams rewrite memory from past sessions and leave the old store intact. Devin proposes knowledge. Sierra's Ghostwriter reviews conversations and suggests changes. The common shape is propose, show a diff, let a person accept.

6. **Work runs in the background on schedules and triggers.** Cowork, workspace agents, Notion, Jules, Gemini Enterprise and Managed Agents all added schedules or event triggers in the past year. "Runs with no device online" is now a headline feature.

7. **Persistent workspaces hold the context.** Claude projects, Gemini Enterprise Projects, Dust Pods and per-agent workspaces in ChatGPT keep files, instructions and memory together. The workspace outlives any one conversation.

8. **Open protocols connect agents across vendors.** A2A reached version 1.0 in 2026 with more than 150 supporting organisations, and sits beside MCP under the Linux Foundation's Agentic AI Foundation (secondary). Slack, Google and Microsoft all accept outside agents. A platform's agents will need to be callable from other platforms.

9. **A control plane for governance becomes a product of its own.** Agent 365, Google's Agent Gateway and registry, and ChatGPT's admin roles sell audit, policy and risk views. Small companies will want a light version: who owns it, what it can touch, what it did, what it cost.

10. **Spend moves to credits with per-agent caps.** Microsoft, Notion, OpenAI and Lindy all bill in credits now. Caps, alerts and auto-pause follow.

### Design questions every platform must answer

**What is the unit?** Anthropic and Devin chose the task or session. Microsoft, Notion, Lindy and ChatGPT workspace agents chose the named agent. Slack chose the conversation. The choice decides the home screen. For a small company I think the agent is the unit people name, and the task is the unit they track.

**Where does the human sit?** In the chat, in an inbox of things that need a decision, or on a dashboard watching. Most products now offer all three and pick one as the default. The default says who the product is for.

**How are teams shown?** As an org chart, a flat group like a Zapier pod, a shared room like a Dust Pod, or a lead with helpers that appear only while a job runs. Related: can the user talk to a helper directly, as Claude Code allows, or only to the lead?

**Whose permissions does the agent use?** The user's, its own, or a shared channel identity. Notion and Claude Tag show that one product may need two answers.

**How is trust built?** Options are a live view, a plain-language run log, default approvals on writes, a visible memory, a test run before release, and spend caps. Each costs attention. Pick the few that match the risk.

**How does the agent learn, and who approves it?** Silent learning is convenient and hard to trust. Reviewed learning is safer and adds work. Scope matters too: per user, per channel, per agent or company-wide.

**How do people create and change an agent?** Describe it, pick a template, or draw it. And after the first day, how does a non-technical user fix an agent that is slightly wrong?

**Which channel is home?** If agents live in Slack, email and chat, one place still has to hold settings, memory, files and history. Decide whether that place is a daily tool or a back office.

**What happens when the agent is stuck or wrong?** Who gets told, where, and how do they undo the action? Notion leans on version history. Few others have a clear answer.

**What does the user see about cost?** Tokens, credits, money, or a simple monthly budget per agent.

## Sources

All accessed 19 Nov 2026. openai.com returned HTTP 403 and was not read.

Microsoft
- https://learn.microsoft.com/en-us/microsoft-agent-365/overview
- https://learn.microsoft.com/en-us/microsoft-agent-365/developer/identity
- https://blogs.microsoft.com/blog/2025/04/23/the-2025-annual-work-trend-index-the-frontier-firm-is-born/
- https://virtualizationreview.com/Articles/2025/04/23/2025-Work-Index-All-Employees-Will-Be-Agent-Bosses.aspx
- https://holgerimbery.blog/copilot-studio-orchestration-part3
- https://candede.com/articles/microsoft-copilot-studio-2026-release-wave-1
- https://cloudwars.com/ai/copilot-studio-agents-become-more-integrated-proactive-teammates/
- https://blog-en.topedia.com/2026/04/agent-registry-is-moving-from-microsoft-entra-to-agent-365/

Anthropic
- https://support.claude.com/en/articles/13345190-getting-started-with-cowork
- https://support.claude.com/en/articles/14116274-organize-your-tasks-with-claude-cowork
- https://platform.claude.com/docs/en/managed-agents/overview
- https://platform.claude.com/docs/en/managed-agents/dreams
- https://code.claude.com/docs/en/agent-teams
- https://www.datacamp.com/blog/claude-tag
- https://www.techrepublic.com/article/news-anthropic-claude-tag-ai-agent-slack/
- https://www.eesel.ai/blog/claude-tag

OpenAI
- https://openai.com/index/introducing-workspace-agents-in-chatgpt/ (blocked, 403)
- https://venturebeat.com/orchestration/openai-unveils-workspace-agents-a-successor-to-custom-gpts-for-enterprises-that-can-plug-directly-into-slack-salesforce-and-more
- https://www.ubergizmo.com/2026/04/openai-introduces-workspace-agents/
- https://thenewstack.io/openai-launches-a-no-code-agent-builder/
- https://zenml.io/llmops-database/building-and-deploying-the-codex-app-a-multi-agent-ai-development-environment

Google
- https://cloud.google.com/blog/products/ai-machine-learning/the-new-gemini-enterprise-one-platform-for-agent-development
- https://cloud.google.com/gemini/enterprise/docs/agents-gallery
- https://cloud.google.com/agentspace/agentspace-enterprise/docs/agent-designer
- https://www.testingcatalog.com/google-to-add-scheduled-jobs-and-proactive-mode-to-jules-agent
- https://rywalker.com/research/jules

Agent-as-teammate products
- https://lindy.ai/llms.txt
- https://www.lindy.ai/blog/lindy-assistant-launch
- https://www.wearefounders.uk/lindy-ai-review-2026-is-it-worth-it-for-solo-founders/
- https://rywalker.com/research/lindy
- https://relevanceai.com/docs/get-started/core-concepts/workforces
- https://relevanceai.com/blog/introducing-workforce-the-visual-canvas-for-building-ai-teams
- https://relevanceai.com/workforce
- https://sierra.ai/product/agent-studio
- https://sierra.ai/blog/redesigning-agent-studio-around-ghostwriter
- https://www.unite.ai/sierra-puts-ghostwriter-at-the-center-of-agent-studio-workflows/
- https://docs.dust.tt/docs/pods-overview
- https://docs.dust.tt/changelog/dust-global-agent-now-uses-memory
- https://tech.eu/2026/05/18/dust-raises-40m-series-b-to-build-the-multiplayer-operating-system-for-enterprise-ai/
- https://www.notion.com/product/agents
- https://www.notion.com/help/custom-agent-pricing
- https://slack.com/blog/news/slack-is-where-agents-work
- https://slack.com/blog/news/slackbot-context-aware-ai-agent-for-work
- https://slack.com/blog/news/agent-first-workspace-slack
- https://www.zapier.com/blog/zapier-agents-pods-dashboards
- https://zapier.com/agents/templates
- https://help.zapier.com/hc/en-us/sections/33250054078477-Manage-agents
- https://docs.devin.ai/release-notes/overview
- https://cognition.com/blog/how-cognition-uses-devin-to-build-devin
- https://cursor.com/blog/cloud-agents
- https://www.digitalapplied.com/blog/cursor-3-agents-window-complete-guide
- https://linear.app/docs/agents-in-linear
- https://linear.app/docs/assigning-issues
- https://linear.app/developers/aig
- https://linear.app/developers/agent-best-practices
- https://cdn.jsdelivr.net/gh/paperclipai/paperclip@master/README.md
- https://paperclip.ing/docs
- https://betterstack.com/community/guides/ai/paperclip-multi-agent/

Protocols
- https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
- https://forkast.news/googles-a2a-protocol-joins-aaif-consolidating-the-agent-economys-protocol-layer-under-one-roof/
