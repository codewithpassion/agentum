---
id: OB.3
title: The install script checks the machine and can make a desktop
milestone: OB
size: M
status: in_progress
depends_on: [OB.2]
branch: task/OB.3-install-doctor
lane: computer
executor: claude
---

From the 10 Nov 2026 review. The Claude CLI login is an unstated prerequisite, and the curl install cannot set up a desktop.

## Scope

- `install-agentum.sh` runs `agentum doctor` at the end and prints failed checks with the fix.
- The client reports failed checks, and the machine row shows them.
- `AGENTUM_DESKTOP=1` installs and enables the desktop role's packages.

## Check

- Script tests for both paths. On a clean Linux VM: install with and without the flag, and the row shows a missing Claude login.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
- 2026-11-10: dispatched to a Sonnet implementer on task/OB.3-install-doctor. Only schema task in this wave. Clean VM check uses a fresh Docker container.
