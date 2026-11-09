---
id: OB.2
title: Enrolling a machine, one path that confirms
milestone: OB
size: M
status: in_progress
depends_on: []
branch: task/OB.2-enrol-dialog
lane: web
executor: claude
---

From the 10 Nov 2026 review. Files: `apps/web/src/routes/_app/settings.machines.tsx`, `components/machines/enroll-dialog.tsx`, `enroll-commands.ts`.

## Scope

- The empty state shows no command without a code. Its button opens the dialog.
- One button and one name on the page and in Find. "Both roles" is the default.
- The dialog polls `machines.list` and shows "Connected" with the machine's name, or what to check after a minute.
- Revoked machines are hidden behind a toggle.

## Check

- Component tests. On staging: enrol a machine and see "Connected" without a reload.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
- 2026-11-10: dispatched to a Sonnet implementer on task/OB.2-enrol-dialog. Lane rule relaxed for this run (Dom asked for about six in parallel): its files do not overlap the other running tasks, only shared registries, which merge cleanly. Staging check runs after merge, by the controller.
