---
id: NV.1
title: "One word per thing in the web app"
milestone: NV
size: M
status: in_progress
depends_on: []
branch: task/NV.1-one-word-per-thing
lane: web-shell
executor: claude
---

From `docs/v4/build-plan.md`, milestone NV. The app uses task, run, session and thread for one conversation, and Find labels differ from page headings. This task applies the vocabulary table in `docs/v4/build-plan.md`. Labels only: no route, table or tRPC name changes.

## Scope

- Apply the vocabulary table to every user-visible string in `apps/web/src`: a session or agent thread is a "conversation", a run is a "task" ("Task 3 of 3"), `/sessions` is headed "Conversations".
- Make each Find label in `components/rail/find-registry.ts` equal the `<h1>` of the page it opens. Fix the pairs the inventory lists: Threads and Inbox, Questions and Q&A, Schedules and Routines, Web triggers and Triggers, Files and wiki and Library, Things agents made and Artifacts.
- The New menu reads "New conversation" and "New agent". The profile's Conversations and Recent tasks cards keep their content and get the new words.
- Do not touch `components/ui/`, `components/agent/agent-form.tsx` (NV.2) or server code.

## Check

- `find-registry.test.ts` gains a test that each entry's label matches a heading constant exported by its route, and passes.
- `grep -rn "Run [0-9] of\|New task" apps/web/src --include=*.tsx` finds nothing outside tests.
- Browser: open Find, visit each entry, heading matches the label.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/NV.1-one-word-per-thing (v4 controller session).
