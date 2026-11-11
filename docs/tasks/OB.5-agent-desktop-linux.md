---
id: OB.5
title: agent-desktop as an opt-in Linux desktop backend
milestone: OB
size: L
status: in_progress
depends_on: [OB.4, AB.1]
branch: task/OB.5-agent-desktop-linux
lane: computer
executor: claude
---

Dom chose on 11 Nov 2026 to build the Linux backend that the OB.4 spike recommended, as an opt-in, with no macOS support. The design is in `docs/reviews/tasks/OB.4.md`, sections "How it maps onto the computer protocol", "What the integration needs in `desktop.rs`" and "Ask-before and allow list it would need". Follow it.

## Scope

- Typed ops `desktop_snapshot`, `desktop_act` and `desktop_apps` in `packages/protocol/src/computer.ts`, added to `DESKTOP_OPS` so they take the desktop lease, with tools in `packages/mcp/src/tools/computer.ts`. Not through `exec`.
- `desktop.rs` starts a session bus per desktop and passes it to the WM and every command. The image adds `dbus`, `dbus-x11`, `at-spi2-core` and the pinned agent-desktop binaries (x86_64 and aarch64).
- Off by default. `ComputerConfig` gets an `allow_apps` list, and empty means no agent-desktop. A snapshot with no app is refused. `desktop_act` re-checks the app through the snapshot id. `read_only` refuses `desktop_act`.
- Chromium accessibility (`--force-renderer-accessibility`, `ACCESSIBILITY_ENABLED=1`) only when the opt-in is on.
- Ask-before: `desktop_act` is gated by default, and `headed` has its own key and is denied by default. The audit records app, ref, action and the typed character count, never the typed text.
- No macOS.

## Check

- Unit tests for the policy (no-app snapshot refused, unknown snapshot refused, read-only refuses act, allow list).
- The OB.4 "Hello, Ada" run through the real worker with the opt-in on, and the ops refused with it off.
- `bun run check && bun run test && bun run build` pass, and `cargo test` in `apps/agentum`.

## Log
- 2026-11-11: added from Dom's decision on OB.4. Not dispatched today, because it is size L.
- 2026-11-11: Dom said "Start now". Dispatched as one task, not split.
