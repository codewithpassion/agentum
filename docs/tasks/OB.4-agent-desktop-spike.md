---
id: OB.4
title: Spike, agent-desktop as a second desktop backend
milestone: OB
size: M
status: done
depends_on: []
branch: task/OB.4-agent-desktop-spike
lane: computer
executor: claude
---

From the 10 Nov 2026 review. Vercel Labs `agent-desktop` (Apache-2.0, https://github.com/vercel-labs/agent-desktop) drives apps through the OS accessibility tree on macOS, Windows and Linux. Agentum's desktop is pixel based and Linux only (`apps/agentum/src/desktop.rs`).

## Scope

- A spike, not a feature. Answer in `docs/reviews/tasks/OB.4.md`: does AT-SPI work inside the current Xvfb container, how do snapshot and act-on-ref map onto the computer protocol so `computer/policy.rs` and `audit.rs` still apply, what a snapshot costs in tokens against a screenshot, and what it would take on macOS.
- Recommend go or no-go, with the ask-before flag and per-app allow list it would need.

## Check

- The write-up, with one recorded run of a real task through each backend.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
- 2026-11-10: dispatched to a Sonnet implementer on task/OB.4-agent-desktop-spike. Spike, no product code.
- 2026-11-10: Review clean after 1 fix round. Recommendation: go on Linux as an opt-in second backend, no-go on macOS until tried on a Mac. AT-SPI works in the bookworm desktop image under the shipped seccomp profile. Dom decides whether to schedule the Linux task in the write-up. Merged as f815f363. check, test and build green on main (guest-execution.test.ts failed under full-suite load and passed alone, as on main before).
