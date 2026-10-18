---
id: W.4
title: Attachments from the Linux VM
milestone: W
size: S
status: done
depends_on: [W.2]
branch: task/W.4-vm-attachments
---

Asked for by Dom on 18 Oct 2026, from the report (section D, "VM attachments"). `[ATTACHMENT:path]` markers are read from the library only, so a file written in the VM cannot reach the user (`pi-run-files.ts`, C.14 review idea).

## Scope

- In a VM session, `outputsOf` reads marker paths from the VM with `readFile`. It refuses paths outside `/workspace` and `/tmp`, and keeps the same size cap and notes as `uploadOutputs`.
- `filesExtension` renders the work directory per environment, so VM sessions no longer see `/library` in the attachment text.

## Check

- `pi-run-files.test.ts` with the fake VM covers a home file, a scratch file, a refused path and a missing file.
- Live on staging (controller): a VM agent returns a file from `/workspace/home` as a chip in the chat.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-18: added at Dom's request.
- 2026-10-18: dispatched.
- 2026-10-18: review clean after 0 fix rounds at f752092 (docs/reviews/tasks/W.4.md). Merged. Staging check pending.
- 2026-10-18: staging check passed (VM file returned as chip, download 200 with content).
