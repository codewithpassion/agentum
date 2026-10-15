---
type: "note"
title: "Agent platform vision for SMBs (brain dump, 16 Oct 2026)"
tags: ["harbourmaster","agentum","bruce","mcp","agents","brain-dump"]
visibility: "private"
---

# Agent platform vision for SMBs

Brain dump from Dom, Friday 16 October 2026 (dictated while travelling). Project: [Harbourmaster](../index.md) (the name was chosen after this dump was written).

## Where things stand

Recent work on Dom's own AI operating system:

- A control plane that collects data and events from different sources
- Claude Code used via remote control
- Bruce, an agent based on Claude Code, plus a version of Bruce built on the Anthropic Agent SDK
- Agentum, an online platform for creating agents in the cloud, based on Claude managed agents. It already gives an agent real access to a remote computer with a full desktop.

## The vision

Make it simple for an SMB to build an agent and interact with it, while staying flexible enough for Dom to use it too, for example by connecting a Claude Code instance running on a machine he controls.

## Inspiration

Inspired by other people's AI operating systems, which usually lack the option to have actual agents. Other inspirations: GrokBot, Muse Agent, Hermes, OpenClaw and OpenAI Dot.

## Creating and running agents

- A simple UI to create a new agent
- Configure where it runs: as a Cloudflare agent, on Claude managed agents, maybe another service, or on an always-on remote machine connected to the server
- For real machines, choose whether the process runs natively or in a Docker or Podman container
- One physical machine can hold more than one agent, in dedicated directories and/or user accounts
- A frontend a bit like Claude Desktop, to create agents and run them locally straight away
- The frontend should be reasonably simple
- The whole project can be hosted on Cloudflare, or driven locally

## Talking to agents

- Connect Claude to the platform via MCP, so Dom can say "Hey Claude, message Bruce to go and grab the latest Plaud or Granola transcript and do something with it"
- Sessions are stored. Agents can look back at their own sessions, or ask other agents for an extract or info from an old session.
- An inbox system, separate from Slack, where agents message each other, comment on things and ask questions, like a forum. Buzz from Jack Dorsey has something like it.

## MCP connectors and credentials

- One central place to manage MCP connectors
- Connectors are created once and can be assigned to multiple agents
- User-bound authentication must support OAuth, and must re-trigger auth when needed
- External connectors need more than one auth method: OAuth, header auth and others, and also multiple OAuth setups
- Three credential cases to cover:
  - Linked to a specific user, so it looks like Dom is acting in the external system
  - When a colleague tasks the agent, it acts under that colleague's credentials
  - Agent credentials, for when the agent runs on a routine or an event and needs its own auth
- Secrets kept in vaults that can be given to agents

## Slack, triggers and gateways

- Easy to connect an agent to Slack. Ideally the platform guides Dom through creating a management token, then installs the Slack app into an org in as few clicks as possible (OAuth may be needed).
- Triggers: a Slack message, an external API endpoint with bearer auth that triggers an action, and routines (like cron jobs)
- An agent can be tagged in Slack to do work in a thread, or monitor all messages in a channel and be proactive
- Start with Slack, but other gateways may follow

## Files

- Easy file exchange: upload files via Slack, and connect Google Drive
- For Google Workspace, possibly scan everyone's Meet folder
- A connection to a Windows or Samba drive through a gateway process would be amazing
- Shared Google Drive, maybe OneDrive too
- An agent can be triggered when a file lands somewhere

## Logging and knowledge

- Every action goes into an append-only log, so patterns can be learned from it
- A shared knowledge base wiki, probably built as a file structure with file commands, maybe using the "just bash" package

## First iteration: auth and permissions

- Auth via Clerk
- Keep permissioning to a minimum. No fine-grained permissions yet, because Dom first needs to see how this works. It will be needed later, so keep it in mind.

## Tech

Built primarily in TypeScript. Connector applications may use other languages, for example Agentum uses Go.

## Reference projects

- [agentum](https://github.com/codewithpassion/agentum)
- [trueforge](https://github.com/codewithpassion/trueforge)
- [durable-pi](https://github.com/codewithpassion/durable-pi)
- [control-plane](https://github.com/codewithpassion/control-plane)
- [flightdex](https://github.com/codewithpassion/flightdex)
- [ariadne](https://github.com/codewithpassion/ariadne)
- [the-brain](https://github.com/codewithpassion/the-brain)
- [bruce-next](https://github.com/codewithpassion/bruce-next)
