---
id: ME.9
title: "Memory walkthrough on all three runtimes"
milestone: ME
size: M
status: done
depends_on: [ME.3, ME.4, ME.5, ME.6, ME.7, ME.8]
branch: task/ME.9-memory-e2e
lane: e2e
executor: claude
---

From `docs/v4/build-plan.md`, milestone ME. End-to-end check for ME.

## Scope

- With the fake runtime: tell an agent to remember something, start a new conversation, confirm the note is in the run input and the agent uses it.
- Set `ask_first`, have the agent call `remember`, approve from the Needs you drawer.
- Check a private note is invisible to a second member in the Library page.
- On a real machine agent and a cloud agent on local, confirm the memory folder arrives by library sync. Managed Agents: list as a step for Dom if it needs the staging key.
- Findings to `docs/reviews/ME-e2e.md`.

## Check

- The walkthrough passes on local for the fake, machine and cloud runtimes.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/ME.9-memory-e2e (v4 controller session).
- 2026-11-20: merged as eb3c7b06, review clean after 1 fix round. Walkthrough passed at both sizes on the fake runtime, a cloud agent (faux and claude-haiku-5-5) and a real machine agent: docs/reviews/ME-e2e.md. The browser report reads fail only on a dev-login 400 and a deliberate 404, neither a memory defect. check, test and build passed on main. Follow-ups ME.11 to ME.13. Dom: Managed Agents memory check on staging; a private-note check with two real members after deploy.
