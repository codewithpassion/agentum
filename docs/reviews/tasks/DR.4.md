# DR.4 review: the dream run

Task: schedule, model, write, diary, undo (`packages/services/src/dream.ts` and `dream/`). Built by Haiku workers (diary, desk cards, rail pass-through, guards) and the dispatcher (the run, the changeset, undo, the trigger, the model call), reviewed by Opus.

## Verdicts

- Round 1 at `5502a985`: not clean, four must-fix. Undo reset `index.md` to empty when the dream left it unchanged or made it. Undo restored old index bytes over a later write to another file. Approving a held batch overwrote notes a person edited after the dream. A held batch has no Needs you card (left to the controller, see below). The reviewer also asked for one extract call per person and a per-person prune budget.
- Fix round 1 at `381a4956`: not clean, two must-fix. The held batch recorded its file versions after the model calls, and the person budget in prune left out the shared notes the plan adds.
- Fix round 2 at `86ee56d9`: clean.
- Round 3 at `515bb9fd` (merge of main with SP.3, and the paused-agent skip): clean. Nits: a pause that lands between `fireDue` reading the due slots and `run()` loading the agent still costs that night's dream, because `fireOne` has moved the slot; a finished dream never calls `spend.enforceCap`, so a dream that crosses the weekly cap pauses the agent only after its next ordinary run.
- Round 4 at `b32f7c6a` (the claude-haiku-5-5 price correction, see the cost line under Decisions): clean. Nit left: the price tier is chosen by the 100K character evidence cap, which is not a token count, so a prompt of dense non-English text could pass 100K tokens and be undercounted.

## Decisions made

- The service reads and writes the library as a user-shaped principal marked `dream: true` and named `dream:<agentId>` (`workspaces.ts`, `library.ts`, `dream/rows.ts`). The library has no other writer, and a person's principal cannot reach other people's private files. The mark is set only in `dream/rows.ts`. Library events and file authorship show the id `dream:<agentId>`.
- The plan is applied through `memory/files.ts` (`commitFiles`), the only caller of the library's memory write (`scripts/memory-sole-writer.test.ts`). One call writes every changed file, the library versions, the `memory_changes` rows, the questions and the run row, so a failed dream leaves memory as it was.
- Any failed model call fails the run, including a judge call, so a plan is never written with part of the model's work missing. An answer the model gave but that cannot be read still degrades as the DR.2 steps expect. The failed run keeps its token usage.
- The learn level `ask_first` holds the whole plan, and so does any plan that cites outside evidence (mail, a peer). Held rows are the plan. Approve and reject act on the batch through `dream.decide`; `memory.decide` and `memory.undo` refuse every row with a `dream_run_id`.
- A held batch records the latest library version of each file it touches in `dream_runs.base_version`, read before the files. Approve is refused with `conflict` when any of them changed since.
- Undo restores the base bytes of every note file the dream wrote, in one library commit, and rebuilds `index.md` from the restored files. A file the dream made goes back to an empty file. Undo is refused with `conflict` when any of those files was written after the dream, instead of throwing a person's notes away. It is also refused while a memory file does not parse.
- Extract makes one model call for each person's private evidence and one for the rest, so a call never sees two people's words. A note's owner comes from the evidence it cites, in code, never from the model. Private evidence with no person who has a private file is not sent. A note that holds a secret or mentions the workspace's or agent's never list is dropped.
- Prune runs per scope: the shared notes first, then each person's notes against what the shared notes leave of the 6000 character prompt budget.
- A question's options are stored with the `userScope` of their notes in the existing `options` JSON (`dream/question-options.ts`), because `dream_questions` has no scope column and this task does not change the schema. The desk, the rail and `dream.answer` read it, so a question about a private note reaches that person alone. A question already open for the same notes is not asked again.
- Answering forgets the other options as the person who answered (`memory.forget`), so those are ordinary memory changes the person can undo.
- Scheduling. `syncDreamTriggers` (`dream/trigger.ts`) makes one live `dream` trigger per active agent whose schedule is not off, at `0 2 * * *` (nightly) or `0 2 * * 0` (weekly, Sunday), in the workspace's timezone. `memory.rules.set` calls it for its agent. The minute tick's `dream.sync` job repairs the rest: new agents, agents from before dreams, a changed workspace timezone. No agent creation path needed a change. The `dream.fire` job claims each due slot with a compare-and-swap on `next_run_at`, moves it to the next 02:00, and starts up to 5 dreams a tick.
- `dream.runNow`, `undo` and `decide` need the agent's owner or an org admin on a browser session. `list`, `get` and `changes` are open to any workspace user, and a person's private change rows are shown only to that person.
- A paused agent (`agents.paused_at`, from SP.3) does not dream. `fireDue` leaves its slot due, so it dreams on the first tick after it resumes, and `run()` (so `dream.runNow` and the tick alike) refuses with `conflict` and records no run, so the next dream still reads everything since the last one.
- The held-batch rows are left off the `memory_note` Needs you cards, because `memory.decide` refuses them.
- DR.2 notes done: an empty-absorbed merge is applied as an edit; a merge whose text equals the keeper's leaves the keeper's writer and date; a question's scope comes from its notes; prune's budget is the prompt budget less the text the plan adds; reconcile's held ids go to prune; triggers refuse `reassign`, `setEnabled` and `revoke` on a dream trigger; `DeskCard.dream` reaches `RailCard.dream` through a helper that keeps `rail.ts` under the complexity limit.
- The model's cost is `DREAM_PRICE_PER_MILLION` in `dream/model.ts`, set to the claude-haiku-5-5 rates for prompts up to 100K tokens ($0.10 in and $0.50 out per million; $0.50 and $2.50 above 100K, first-party rates of 3 Nov 2026). The spend rollup already reads `costUsd` from `dream_runs.usage`.

## Nits left

- A held batch has no UI to approve or reject. `dream.decide` and its tRPC route exist, and the changes list shows the rows as held, but nothing in the app calls it, and Needs you shows no card for a held batch.
- `dream/run.ts`: `claim` checks for a running dream and then inserts, with no unique index, so a Dream now and the tick can start together. The second fails on the file etag. `fireOne` in `dream.ts` moves the slot before the dream starts, so a dream that cannot start loses that night.
- Approve and reject can race: reject first, then approve still writes the files while its row updates (guarded by `status = held`) change nothing.
- Answering a question is not atomic. A retry with a different choice can forget the note kept the first time. Undo and reject leave the run's open questions open.
- `memory/service.ts`: the trigger sync error in `rules.set` is dropped without a log.
- `dream/trigger.ts`: a dream trigger is not revoked when its agent is archived (it does not fire). An agent whose workspace timezone is invalid is retried every minute and can crowd the batch of 100.
- Merge and prune text from the judge is not checked against the never list or the secret patterns. Only the candidates are.
- `versionIds` is optional on `LoadedMemory` and filled only by `loadEveryMemoryFile`. Approve and undo pay one extra version lookup per file for it.
- No test for the budget fix (`addedBy(null)`), for undo refusing an unparsable file, or for a held batch's question text.

## Ideas beyond the scope

- A Needs you card and Knows tab buttons for a held batch (approve all, reject all). It needs a `NEEDS_YOU_KINDS` entry or a `memory_note` card that carries the run id, and a click handler that calls `dream.decide`.
- Give library events and file authorship an `agent` or `dream` actor kind, so the activity feed does not show `dream:<agentId>` as a person.
- An index on `dream_runs(agent_id)` where `status = 'running'`, to make the one live dream a rule the database holds.

## Test notes

- 24 new test files or additions under `packages/services/src/dream/` (run, trigger, extract, model, diary) plus `library-memory.test.ts`, `memory/service-dream.test.ts`, `triggers.test.ts`, `desk.test.ts`, `rail.test.ts`. They map to the task's check: full run, skipped run, held batch (approve, reject, stale approve), undo byte for byte and its refusal after a later write, a question answered both ways, a private question, a cron test that fires a nightly and a weekly schedule in Sydney across the UTC date line, a timezone change, and a failed model call (extract and judge) that leaves memory unchanged.
- `bun run check` and `bun run build` pass. `bun run test` passes in every package.

## Steps for Dom

- None for the migration: DR.4 adds no migration.
- A dream needs the workspace's Anthropic API key (Settings, Anthropic API key). Without one it records a failed run that says so.
