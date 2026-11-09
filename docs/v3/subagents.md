# Subagents

A subagent is a child run of the same agent. It has its own session, model and
usage record, and appears under its parent in the task view. It keeps the
parent's person delegation. A helper started from a UI or private session stays
private to the delegated person. It runs on the same runtime as its parent: the same
machine, managed, or cloud.

Subagents are off by default. The agent's owner or an organisation admin can
turn on **Subagents** in the agent profile. The agent prompt then explains how
to start helpers and check their results.

A parent chooses any model the workspace allows for that runtime. A helper can
use a cheaper or a stronger model. Connectors, secrets and tools come from the
parent by default. Passing a list narrows that access; an empty list gives none.
The server intersects access with the parent's access, so a helper cannot gain
anything its parent lacks. Secret-linked connectors keep their own access rules.

## Tools

- `start_subagent({ task, model, connectors?, secrets?, tools?, requestId? })`
  starts a child and returns its run id at once. Connector and secret lists use
  ids; tool lists use tool names. Retrying the same `requestId` returns the first
  run.
- `subagent_status({ id, waitMs? })` returns `pending`, `done` or `failed`, status
  text, and the answer when done. It can wait up to 25 seconds.
- `message_subagent({ id, text })` starts a follow-up run in that helper's
  session, still a child of the calling run.
- `stop_subagent({ id })` cancels a helper.
- `list_subagents()` lists the calling run's helpers with their model, state and
  a one-line summary.

These tools are offered only to runs of agents with Subagents enabled. A run
can see and control only its own descendants. The service checks this on every
call, even if a caller bypasses tool discovery.

## Limits and lifetime

A parent can have at most five live subagents. A subagent can start helpers one
more level down; those level-2 helpers cannot start more. Every child also counts
toward the existing run tree depth limit of three, shared with hand-offs to
other agents. Mixing hand-offs and subagents does not reset that limit.

When a parent finishes, fails or is cancelled, its live subagents are cancelled.
A helper cannot outlive its tree. Its model usage and cost are recorded on its
own run like any other run.

## Machines and Claude Code

Claude Code's built-in subagent tool stays available on machines. Those helpers
belong to Claude Code's process. Agentum subagents use the tools above and are
separate runs and sessions, with their chosen model, access, usage and lifetime
managed by Agentum. Managed and cloud agents use the same Agentum tools.
