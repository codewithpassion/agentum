---
id: RC.2
title: Rust client core
milestone: RC
size: L
status: done
depends_on: []
branch: RC-rust-client
lane: rust
executor: codex
---

Spec: `docs/v3/machine-client.md` ("Layout", "Instances, names and paths", "Commands", "Permissions and help"). Builds against the RC.1 enrol body; if RC.1 isn't merged yet, code to the spec and test with a fake server.

## Scope
- `apps/agentum` Cargo project and its `package.json` scripts.
- CLI with every command from the spec. `service *`, the run handlers for each role and the desktop are stubs that say "not built yet" with exit 1; RC.3, RC.4 and RC.5 fill them.
- Instances, paths, config and credential files with their modes.
- Enrol, including the old spellings.
- The connection loop for both sockets (hello, heartbeat, backoff, close codes per role), with a role trait or module boundary that RC.4 and RC.5 plug their frame handling into without touching the loop.
- status, list, version, exit codes, logging.
- The `privilege` module and `doctor` with the checks that don't need RC.3 to RC.5.

## Check
- `cargo test` covers: serde round trips against every fixture in `packages/protocol/fixtures/`, `apps/computer/testdata/protocol/` and `apps/computer/testdata/enroll/`; slug and instance rules (collision refused, single instance optional, several listed); file modes; enrol against a local fake server for both old spellings and the new form; the connection loop against a fake WebSocket server for each role (hello sent, heartbeat timing, backoff, 4401 exits 3, replaced handling per role); every `privilege` explanation has a test that renders it.
- `bun run check && bun run test` from the repo root pass (they now run the Rust checks).
- `cargo build --release` works; report the binary size.

## Log
- 2026-11-05: Codex built it (c530c386). Opus review: base not ready to branch (work-root ids, run not wired, shared files). Fixed in eceea285 with ARCHITECTURE.md lanes; 36 Rust tests, 4.4 MB binary. Merged.
