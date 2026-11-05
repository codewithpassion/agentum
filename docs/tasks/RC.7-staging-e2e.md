---
id: RC.7
title: End to end on staging
milestone: RC
size: M
status: ready
depends_on: [RC.6]
branch: RC-rust-client
lane: ops
executor: claude
---

Controller task, needs Dom for anything outside this host.

## Check
- On this host, against staging: enrol one instance with both roles as a user service with linger, run an agent task on it and a computer command, then a second instance with only the computer role. Both show on the Machines page. Revoke one; it stops with exit 3 and doesn't restart.
- `agentum doctor` output is readable and correct on this host.

## Log
