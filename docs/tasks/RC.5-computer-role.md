---
id: RC.5
title: computer role in Rust
milestone: RC
size: L
status: ready
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
