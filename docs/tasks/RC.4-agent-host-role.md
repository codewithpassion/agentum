---
id: RC.4
title: agent_host role in Rust, driving claude directly
milestone: RC
size: L
status: in_progress
depends_on: [RC.2]
branch: RC-rust-client
lane: rust-agent
executor: codex
---

Spec: `docs/v3/machine-client.md` ("The agent_host role", "Driving claude"); parity list `docs/v3/machine-client/inventory.md` 1.5 to 1.9, 1.13, 3 and `daemon.md`.

## Check
- Tests against a fake server: offer, claim with `X-Daemon-Features`, events batching and seq, lease heartbeat and 409, complete for each state, cancel, requests and long-poll, needs-approval, one run per agent with a queue, library_changed.
- The claude driver is tested with a fake `claude` that replays `apps/daemon/fixtures/tool-run/sdk-messages.json` and checks the control requests the client sends; the events and complete body equal `apps/daemon/fixtures/tool-run/{events,complete}.json`.
- The conformance test against the real `claude` (skipped when missing) runs one tool call end to end.
- Library sync and files tests mirror the daemon's.
- `bun run check && bun run test` pass.

## Log
