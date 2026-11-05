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
- 2026-11-06: Dom: "Deploy to staging. Use Morosini to test" (Morosini is this host; sudo allowed for the test). Staging Worker f83e363a from branch 3b474c32, `agentum-rs` 0.1.0+3b474c32 published to staging R2. The old staging and production daemons on Morosini were left running.
- User mode, current user (`rc7-both`, both roles), installed with the Machines page command: enrolled, user service with linger, both roles Online. Doctor all Ok. A real claude run on machine agent `rc7-agent` answered "pong" in 5 s; run 2 in the same thread used Bash (`uname -s && whoami` gave Linux, roboto) and recalled "pong", so session resume works.
- Computer command through a model: not done. Staging has no Anthropic or OpenRouter key, and a machine agent can't have a computer. Both roles' sockets were Online.
- Bug: the page command run a second time (computer-only code for `rc7-computer`) re-enrolled the existing `rc7-both` instance instead of adding one. Fix brief in tmp/RC.7-fix (branch RC.7-fix).
- Two instances at once: `rc7-both` re-enrolled in place with `enroll --instance rc7-both --replace` (machine `rc7-both2`) and `rc7-comp2` (computer only) enrolled with the CLI; both units ran and both machines were Online.
- Revoke from the page: unit failed with exit 3, NRestarts=0, log carried the Problem/Why/Fix. `list` printed raw JSON and doctor didn't mention the revocation (both in the fix brief).
- System mode, agent user (`rc7-sys`), sudo 1.9.15p5, Ubuntu 24.04: installer exit 5 because claude lived only in ~/.local (correct, but the Fix named a missing /usr/local/bin/claude). After copying claude there: unit installed, `visudo -cf` OK, StateDirectory gave svc:agent-group 0710, the agent user can't read the credential, doctor flagged the missing claude login for the agent user.
- Fake claude that ignores TERM and forks a child: Stop in the UI removed sudo, the fake and its child within 2 s and the task showed Cancelled. `systemctl stop` during a run took 5.4 s, left nothing, Result=success; after restart the task showed Interrupted and nothing re-ran.
- `service uninstall` removed the unit and sudoers drop-in and kept enrolment, state and users, as it says.
