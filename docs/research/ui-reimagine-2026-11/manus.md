# Manus: product and UI notes

Researched 19 Nov 2026 from the official docs (manus.im/docs), the Manus blog and press. I did not use the product, so screen descriptions come from docs text read through a summarising fetcher. Labels may differ slightly. "Unverified" means no primary source.

## Overview

Manus is a hosted general agent. A user describes a result, Manus plans and runs the work in a cloud virtual machine with a browser, shell and file system, then returns a report, deck, site or file. The unit of work is the task, not the agent.

"Acquired by Meta" is out of date. Meta announced the purchase on 29 Dec 2025, China's NDRC ordered it unwound on 27 Apr 2026, and press (Caixin, eWeek) reports that Manus has run independently again since about 1 Sep 2026 after a Tencent-led buyback. Some user data was deleted in August 2026. I found no Manus statement, so the details are unverified. Manus 2.0 shipped on 28 Sep 2026 with a new harness (Cascade), the desktop app renamed Manus Studio, Computer Use, and Cue, a separate app for personal agents.

## Onboarding and setup

Sign in, pick a mode at the top of the task (Manus 2.0 Max, 2.0, 2.0 Lite, or Flex for your own model key), type a goal and wait. No agent has to be configured first. The quickstart teaches one habit: state topic, scope and output format, because a specific request uses fewer credits. Projects, Connectors and Skills come later.

## Main UI layout

- Sidebar: new task, Projects (with "+", pin, drag to reorder), Skills, Connectors, Automations, Web development, and the task list with a filter for all, non-project, favourite or scheduled tasks.
- Home: a prompt box and a Build entry for sites, automations and other creation flows.
- Task view: chat, with "Manus's computer" as a side panel that shows each step live (browser, terminal, files). The top right holds Share, Collaboration and "View all files in this task".
- Replay: a share link plays back the steps, and team guests can watch replays. No current doc page describes it, so details are unverified.
- Automations page: Create, Manage (cards with type, app, status, instructions), Updates (runs by date with status and summary) and a calendar view.
- Settings: Mail Manus, Cloud Browser (logged-in accounts, sessions, history), Integrations, My Computer, Usage.

## Talking to agents and organising work

One task is one chat, one sandbox and one result. Follow-ups stay in the task. Branch starts a new task from any reply and keeps chat and files up to that point. Projects are folders with a master instruction and a knowledge base that every new task inherits. Instruction edits apply on the next message, file edits only to new tasks. Tasks also start from email, Slack, the API, Zapier or an automation, and all land in the same list.

## Agent identity and config

Core Manus has no named agents or personas. A Project's master instruction is the closest thing. Flex accepts keys from OpenAI, Anthropic, Google, xAI, Meta, OpenRouter, Fireworks or Modal, and that provider bills the model use. Named agents live at the edges: Manus Agents (Feb 2026) put a personal agent with identity, memory and its own computer into Telegram, and Cue (invite only) gives each agent an email, phone number, wallet with a budget and a computer.

## Memory, knowledge, skills, self-improvement

Knowledge is the Project's uploaded files. Skills are SKILL.md folders with scripts, in the open skill format. A skill is added by "Build with Manus" (after a good task, ask it to save the process), upload, GitHub import or the official library, and invoked with "/". Loading is progressive: name and description at start, body on invoke, resources on demand. "Build with Manus" is the self-improvement loop, and the user triggers it. The docs say a Team Skill Library is coming while the Team page already lists shared skills, so the current state is unclear.

## Teams and multi-agent

- Wide Research: the main agent splits a list job, gives each item to a sub-agent with a fresh context, and merges the results into one table or report. Tested to 250 items.
- Parallel Tasks: on request a main task starts separate tasks, each with its own chat and result. It can check progress, compare outputs and message all of them. Children see a brief plus Project context, never the parent chat, and approvals happen in each child.
- Collab: the owner invites people into one task. Everyone can prompt, prompts queue, and the owner pays. Joining clears sandbox logins and disables connectors.
- Team plan: pooled credits, admin dashboard, shared projects, audit logs, SSO, and free guests who view, download, watch replays and comment.
- Cue: agents in a group chat hand work to each other and the user decides.

## Scheduling, triggers, channels

Automations come in three kinds: Schedule, Triggered task (events from Gmail, Outlook, Mail Manus, Notion, calendars, GitHub, Shopify, RSS or a webhook, with field conditions), and Advanced automation (beta), which builds a workflow from a description for the user to review. Each has test run, pause, edit and "open the original task". A run can continue in one task or start fresh. Triggers pause after repeated failures and show "needs attention".

Mail Manus gives each user a private address that only approved senders can use. Workflow emails are extra addresses with a default prompt. Manus mails a confirmation before a long task, and replying "Cancel" stops it. In Slack, tagging @manus in a thread makes it read the thread, work there and post results, and the task also appears in the web app.

## Execution environment

Each task gets a cloud VM with root access that sleeps when idle. A sleeping sandbox is recycled after 7 days on Free and 21 on Pro. Outputs, uploads and project files survive, temp files do not. Cloud Computer is a paid always-on Ubuntu machine with SSH and a web terminal, for bots and servers. Manus Studio runs tasks on the user's Mac or Windows PC ("Work locally", choose a folder), adds Computer Use for desktop apps and Remote Control from the phone. The website builder makes full-stack apps with login, database and payments, publishes to Manus hosting and supports custom domains and GitHub sync.

## Connectors, MCP, credentials, approvals, safety

The catalogue lists 416 connectors: 13 native, 369 MCP, 34 API key. A custom MCP server is added by HTTPS URL with a key or bearer token and a connection test. Manus recommends a connector in chat and enables it only after the user approves. Cloud Browser keeps the user's logins and asks the user to take over for CAPTCHA, SMS codes or MFA, then resumes. Browser Operator is a Chrome or Edge extension that works in the user's own browser, approved per session, in a tab the user can close to stop it. Studio has three permission modes: Ask for approval, Approve for me (an automatic reviewer passes safe actions and escalates risky ones, the default) and Full access.

## Pricing and usage display

Credits, metered by task complexity. Third-party figures from Oct 2026: Free with 300 daily credits on the Lite model, paid tiers at 20, 40 and 200 USD a month for 4,000, 8,000 and 40,000 credits, Team from 20 USD per seat with pooled credits. Monthly credits expire and add-on packs do not. Hosting is billed separately. The plans doc says the dashboard shows balance, history, spend by task type, low-balance alerts and pre-task estimates. Reviewers say estimates are missing or unreliable.

## What users praise and complain about

Praise: watching the agent work, finished deliverables, research reports, the website builder. Complaints: credits burn fast and unpredictably, tasks stop mid-run when credits end, loops waste credits, tasks marked done without proof, slow support, data lost in the August 2026 migration. Trustpilot sits near 1.3 of 5 while app store ratings are high. Most review sources are competitors' blogs.

## UI and UX patterns worth copying

- Prompt first, configure later.
- A live "computer" panel beside the chat, and replay through a share link.
- Project as instruction plus knowledge plus recommended connectors and skills, inherited by every task.
- "Save this run as a skill" as the visible self-improvement step.
- Automations split into Create, Manage, Updates and Calendar, with test run on every card.
- Browser take-over for logins and CAPTCHA, with notify and resume.
- "Approve for me" as the middle permission mode.
- Branch from any reply, and a table that tells users when to pick Branch, Wide Research or Parallel Tasks.
- Free guest role for results and replays.
- Email channel with approved senders and confirm-before-start.

## Weak spots

- No persistent agents in the core product, so a team of agents has no home in the main UI.
- Cost is opaque before and during a task.
- Parallel tasks share no chat context and need separate approvals.
- Collab clears logins and disables connectors.
- Knowledge edits do not reach existing tasks.
- Ownership churn and the data deletion hurt trust.

## Sources

All accessed 19 Nov 2026.

- https://manus.im/docs/llms.txt, and under https://manus.im/docs/: introduction/quickstart.md, introduction/plans.md, features/overview.md, features/projects.md, features/skills.md, automations.md, features/parallel-tasks.md, features/wide-research.md, features/collab.md, features/mail-manus.md, features/branch.md, features/cloud-browser.md, features/browser-operator.md, features/desktop.md, integrations/connectors.md, integrations/custom-mcp.md, integrations/slack-integration.md, website-builder/getting-started.md, models/manus-flex.md
- https://manus.im/blog/introducing-manus-2-0
- https://manus.im/blog/manus-sandbox
- https://manus.im/blog/manus-cloud-computer
- https://manus.im/team
- https://www.testingcatalog.com/manus-ai-launched-24-7-agent-via-telegram-and-got-suspended
- https://www.caixinglobal.com/2026-08-12/manus-cuts-ties-with-meta-as-tencent-emerges-as-top-backer-102473415.html (search snippet only)
- https://eweek.com/news/meta-manus-ai-deal-china-unwind-apac/ (search snippet only)
- https://usecarly.com/blog/manus-ai-review and https://eesel.ai/blog/manus-ai-pricing (competitor blogs: timeline, complaints, prices)
- https://www.techjockey.com/blog/how-to-use-manus-ai/amp (May 2025, computer panel and replay)
- https://manus.im/pricing gave the fetcher no plan data, so prices are third party.
