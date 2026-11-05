---
id: RC.5
title: computer role in Rust
milestone: RC
size: L
status: done
depends_on: [RC.2]
branch: RC-rust-client
lane: rust-computer
executor: codex
---

Spec: `docs/v3/machine-client.md` ("The computer role"); parity list `docs/v3/machine-client/computer.md`.

## Check
- Every Go test area has a Rust equivalent: protocol fixtures byte for byte, policy flags, limits, file transfer and chunking, audit rotation, run-as-root refusal, the desktop (unit tests with fakes; one real Xvfb test when Xvfb is installed, skipped otherwise).
- `bun run check && bun run test` pass.

## Log
- 2026-11-06: Codex built it (db80145c, f47f482b, 1ff36593). Opus review: agent-user worker sudoers mismatch with RC.3, worker crash handling, oversized replies, 14 unported Go tests; fixed in 4d19b1ee and fe64f41b. Full desktop test skipped (no openbox on this host).
