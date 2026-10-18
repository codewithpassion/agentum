---
id: W.1
title: Workspace instructions builder shared by all runtimes
milestone: W
size: S
status: done
depends_on: []
branch: task/W.1-workspace-instructions
---

Asked for by Dom on 18 Oct 2026, from docs/analysis/agent-workspace-persistence.md (section D). Every agent should see three areas named the same way in its system prompt: home (kept across its sessions), scratch (temporary) and library (shared, kept). Today each runtime words this on its own, and the Linux VM prompt contradicts the attachment section (`linux-vm/vm-tools.ts`, `library-tools.ts`, `packages/protocol/src/attachments.ts`, the daemon's `systemPrompt.append`).

## Scope

- Add `workspaceInstructions({ home, scratch, library, homeIsLocal })` to `packages/protocol`. It renders the three areas and the attachment line, using the draft text in the report. Scratch text says the files vanish when the VM sleeps or before the next run, so nothing needed later may live there.
- When the library is not a local folder, the text says to reach it with the library tools and never prints a `/library` path as a working directory.
- Keep `attachmentInstructions` until the callers move to the new builder (W.2, W.5, W.6). No caller changes in this task.
- Export it from the existing protocol entry that holds `attachments.ts`. No new package.

## Check

- `bun test packages/protocol` has one case per runtime's inputs (VM, isolate, managed, machine). One case checks that no `/library` appears when the library is not local.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-18: added at Dom's request.
- 2026-10-18: review clean after 1 fix round at ed6b18e (docs/reviews/tasks/W.1.md). Merged.
