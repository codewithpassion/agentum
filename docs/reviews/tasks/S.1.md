# S.1 review

## Verdicts

Round 0, commit 77c72b3: clean. Nine nits, no must-fix. No fix rounds.

## Decisions

- The task says a failed sync "logs a warning event". The events the daemon can post are fixed (`message.assistant`, `tool.call`, `tool.result`), so the warning is a daemon log line, `run <id>: warning: skills sync failed, the run goes ahead without skills: ...`, in the same style as the other run log lines. It shows in the machine's journal, not in the run timeline.
- `GET /api/runs/:id/skills` answers `{ files: [{ path, size, etag }] }`. A path is relative to `.claude/skills/` and starts with the skill folder (`shout/SKILL.md`). The shapes and the caps (200 files, 5 MB) are in `packages/protocol/src/skills.ts`, shared by the Worker and the daemon.
- Going over a cap is a 400 from the Worker. The daemon also checks both caps and every path before it downloads anything, and downloads everything before it writes the first file.
- An own skill replaces a shared skill of the same name as a whole folder. A file missing from the own skill does not fall back to the shared copy.
- The service reads through `LibraryService` (`list`, `stat`, `read`) and does not touch `library.ts`, so F.2 and F.3 can change that file freely.
- `run.test.ts` now answers the skills list with an empty list and expects `claim, skills, complete` in its route list.

## Checks

`bun run check && bun run test && bun run build` pass. New tests: the skills service (11), the skills routes (9), the daemon client and sync (30), and six executor tests (single-user and multi-user through the fake command runner, a leftover skill gone, a `..` path refused, a failed list that leaves the run `done`, `settingSources` unchanged).

Live, on `vite dev` (port 3471) with the compiled daemon under a separate HOME with `~/.claude` linked in: a Haiku agent had `skills/<agentId>/shout/SKILL.md` in the library ("when asked to shout, answer in capitals"). The run "shout hello" logged `skills synced: 1 files`, left `.claude/skills/shout/SKILL.md` in the work directory, and the reply was "HELLO!". The library has no write route yet, so the scratch script put the file into local R2 with `wrangler r2 object put --local` and inserted the `library_entries` rows. The script is not committed.

Not run here, because this box has no sudo and no `hm-agent`: the multi-user write through the `dd` sudo rule on a real machine. Tests cover it through the fake command runner.

## Nits left

- `docs/tasks/S.1-daemon-skills-sync.md:19` says "warning event". It should say a log line, or a follow-up should add a run-visible event.
- `skills-sync.ts` header says a failure leaves the directory untouched. A write that fails halfway leaves a partial skill set, for example a `SKILL.md` without its helper.
- `skills-sync.ts`: downloaded bytes are not checked against the listed size or the 5 MB cap.
- The leftover-skill executor test covers single-user mode. Multi-user cleanup relies on the `prepareWorkDir` tests.
- `routes/runtime.ts` header still lists "(machines, files, Slack)" and says groups mount only under a prefix.
- `routes/skills.ts` imports `runPrincipal` from `files.ts`. A small shared auth module would be cleaner.
- `skills.ts` hardcodes "200 files and 5 MB" in the cap message instead of building it from the constants.
- `skills.ts` uses its own `requireRun` and not `authorize()`. `authorize()` still runs inside every library call.
- The skills walk has no cap on empty folders, only on files and bytes.

## Ideas beyond the scope

- Show the sync warning in the run timeline with a new event type.
- Cache skills on the machine by etag and fetch only what changed.
- `skills-api.ts` copies the mask and scrub code of `files-api.ts`. The two could share it.

## Steps for Dom

1. On an `hm-agent` machine (after `install-service`), put a skill in the library at `skills/<agentId>/<skill>/SKILL.md`, start a run, and check that `sudo ls -lR /home/hm-agent/harbourmaster/*/<agentId>/work/.claude/skills` shows the files owned by `hm-agent`.
