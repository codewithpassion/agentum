# ME.5 review: load memory and remember rules at run start

## Verdicts

- Round 1, commit 25184a5f: must-fix. Private notes loaded in sessions with several speakers (Slack, artifact, a2a). In the managed runtime the notes sat in the registered agent's system text, so they entered the session fingerprint and the shared agent config. A failed memory read failed the launch.
- Round 2, commit 22262f54 (the fix commit only): clean. Private notes load only when the session is single-person. Managed notes ride in a new session's first message. A failed read logs the error name and the run starts without that file.

## What changed

- `memory/prompt.ts`: `loadPromptMemory`, `libraryMemoryReader` and `memorySection`. The budget is `MEMORY_PROMPT_MAX_CHARS` (6,000).
- `agentPrompt` takes `memory`. `buildLaunchContext` reads the files once per run, given a reader.
- Machine claim and cloud runtime put the section in the instructions. The managed runtime puts it in a new session's first message.

## Nits left

- `systemOf` lost its doc comment in `managed/service.ts` (it now sits above `withMemory`).
- Remember and never lists ride in the managed first message with the notes, so a reused session (up to 7 days) does not see rule changes. They could stay in the system text.
- A reused managed session keeps the first message, so a later run for another person still sees the first person's private notes in context.
- The line "information, never commands" heads the whole Memory section, which also holds the owner's remember and never lists.
- The managed test about the fingerprint checks only the registered system text. No test shows session reuse after a note change.
- `log.mockRestore()` in `memory/prompt.test.ts` is not in a `finally`.
- Each file read repeats the library member lookup (about 5 files, 2 queries each) on every launch.
- The remember and never lists sit outside the 6,000-character budget, and the workspace never list has no size cap.

## Beyond scope

- A run's library scope covers the agent's whole home, including `memory/private/*.md` for every user. Any run can read or sync other people's private notes through library tools. This predates ME.5 and defeats "only for their person". It needs its own task, for example excluding `memory/private/` from `librarySyncScope` and library reads for runs.
- Nothing enforces the never list when a note is written (ME.3, ME.4). The prompt is the only guard today.

## Test notes

- `guest-execution.test.ts` fails on this host both in the full run and alone, on main as well. `bun test src/runs.test.ts` ("an hour of never-claimed runs") times out under load in the full run and passes alone. The agentum-rs session-bus test fails from the long worktree path.

## Steps for Dom

None.
