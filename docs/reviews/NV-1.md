# NV milestone gate review, round 1

Commit 06b0e55b on main. Range `nv-start..06b0e55b`, judged against the NV parts of `docs/v4/build-plan.md` (Decisions, Vocabulary, NV overview), the four task files NV.1 to NV.4, the checkout's CLAUDE.md and "Rules that are easy to break" in `docs/HANDOVER.md`. RH.1, KY.1 and FR.1 are in the range too. The only file they share with NV is `packages/services/package.json`, where each adds its own `exports` entry. The merged tree passes check, build and tests, so those merges break nothing in NV.

## Verdict

Must-fix: 1.

NV.3 and NV.4 meet their scope and checks. NV.4's park path holds up. The complete route passes `awaitingAnswer` on to `completeRun`. The park is one `atomic` write with a single winner. A parked run has no lease, so the reaper, heartbeats, run tokens and the machine lane all skip it. Settling it is a single conditional write, and the follow-up keeps the parked run's actor and depth. NV.1 and NV.2 each did what their files asked. The gap sits between them. NV.1 was told to stay out of `agent-form.tsx`, and NV.2's scope named only a few files. So old runtime, run and session words still show in the agent setup and edit flows, which the Vocabulary table marks as done in NV.

## Checks run

- `bun run check`: passed.
- `bun run build`: passed, and no `drizzle` in `apps/web/dist/client`.
- `bun run test`: protocol, mcp, db, a2a and the other small packages passed. The root run stopped at `agentum-rs` because this host has a `cc` shim in `~/.local/bin` that is not a C compiler. I then ran `@repo/services` on its own and it passed (4300 tests, 0 fail). `apps/web` passed 4385 tests with 1 failure, `guest-execution.test.ts`, which failed again on a rerun with a workerd "other side closed" socket error. The NV range does not touch `src/server/live-artifacts`, and the NV.3 and NV.4 records list the same failure on main in this environment.
- `cargo test` with `/usr/bin/cc`: all unit test binaries passed, including `questions_park_only_when_claim_and_deferral_both_say_so`, `parked_question_completes_with_awaiting_answer` and the hello feature test. `tests/relay.rs` `loops_reset_their_own_backoff_and_persist_state` stalled while the web suite shared the CPU, then passed when run alone. `apps/agentum/tests` is not changed in the range.
- Find: every entry's label equals its route's `PAGE_HEADING`, and each heading renders from that constant. Map and Q&A read it through a shared constant. Three exceptions are recorded with reasons.
- `grep -rn "Run [0-9] of\|New task" apps/web/src --include=*.tsx` finds nothing outside tests.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | must-fix | The agent setup and edit flows still show old runtime, run and session words. In Start blank, the dry run note says "The dry run runs on Cloudflare, the runtime you chose" just after the person picks the "Cloud" chip (`components/agent/builder/dry-run-logic.ts`, four strings). The Edit sheet labels the runtime "Runtime" and says "A session stops at $10 of spend" and "The most model turns one run may take" (`agent-form.tsx` lines 313, 323, 437). The Runs on card describes Anthropic cloud as "Managed Agents. Simplest." (`profile-logic.ts`). The move dialog says "This runtime runs Anthropic models only" (`move-agent-dialog.tsx:194`), "the new runtime does not have their context" and "ran on Cloud before" (`move-agent-logic.ts`). Settings say "Cloudflare agents and Managed Agents" (`settings.model-providers.tsx:56`). The secrets notes say "Managed agents" and "machine and managed agents" (`sheets/secrets/runtime-notes.tsx` lines 21, 25). The Map labels runtimes "Cloudflare" and "Our machine" (`components/map/map-logic.ts` `RUNTIME_SHORT`). | NV.1/NV.2 seam | New task, scope and check below |
| 2 | nit | `storedTitle` accepts a stored title with an attachment marker in the middle and shows it raw. The retitle script skips such a row. The NV.3 record notes this for old renames, and it also covers rows the TH.1 backfill wrote. Markers are rare in inputs, so few rows are likely affected. | NV.3 | Known. Let the repair mode in NV.3's ideas also strip markers |
| 3 | nit | The follow-up run's input is the fixed wake line, so the task picker and its Desk card call that task "The questions you asked have closed. Continue the task from where you stopped." The NV.4 record lists only the attribution of its message. | NV.3/NV.4 seam | Title a follow-up run after the parked run, or show it as "Answer to: <question>" |
| 4 | nit | A Desk card for a task with empty input now says "Conversation" where it said "Task". The Vocabulary table calls a run a task. | NV.3 | Known. Use "Task" as the run-title fallback in `runTitleText` |
| 5 | nit | If a parked listener throws, or the follow-up's `startRun` throws, the answer is only logged. The run stays done or parked with nothing to retry it. I confirmed both catch blocks in code. | NV.4 | Known. NV.4's idea of a retry from the minute tick covers it |
| 6 | nit | The session queue banner (`sessions.ts` `queueOf`), the managed claim and library audience still count a parked run as live. I read these three in code. The NV.4 record adds the system claim. | NV.4 | Known |
| 7 | nit | NV.4's check asked for a local fake-runtime run. The fake runtime cannot ask a question, so `requests-parked.test.ts` stood in for it. No real daemon has parked a question yet. | NV.4 | Step for Dom below |
| 8 | nit | The Edit sheet reads "Runs on My computer: laptop", with a capital "My" in the middle of a sentence. | NV.2 | Fold into finding 1, for example "Runs on my computer, laptop" |
| 9 | nit | The retitle script writes the first input as the new title instead of clearing the column. A repaired row then always beats read-time sources such as an HTTP trigger's name. The affected rows are mostly `ui` sessions, where the result is the same either way. | NV.3 | Optional: set `title = NULL` and let the read path derive it |
| 10 | nit | A rename is refused if it contains anything shaped like a tag, such as "Fix the <div> bug". | NV.3 | Known |

## Task for the must-fix

### NV.5: finish the runtime and task words in the agent flows

Size S, executor claude. The files sit in three lanes: `web-agent` (agent form and profile), `web-builder` (`components/agent/builder`) and `web-settings` (model providers), plus one line in `components/map`. RH.4 is in progress in `web-agent` and moves the profile files into tabs, so run this after RH.4 merges or fold it into RH.4.

Scope:

- `components/agent/builder/dry-run-logic.ts`: say "Cloud" instead of "Cloudflare" in every note and blocker, using `RUNTIME_NAMES`.
- `components/agent/agent-form.tsx`: label the runtime field "Runs on". Replace "A session stops at $10 of spend" with conversation wording, and "one run" in the Turn limit text with "one task".
- `components/agent/profile/profile-logic.ts`: describe Anthropic cloud without "Managed Agents". Fix the capital in "Runs on My computer: <name>".
- `components/agent/profile/move-agent-logic.ts` and `move-agent-dialog.tsx`: no "runtime" in text people read. Fix "ran on Cloud before".
- `routes/_app/settings.model-providers.tsx`, `components/agent/profile/sheets/secrets/runtime-notes.tsx` and `components/map/map-logic.ts`: use Cloud, Anthropic cloud and My computer.
- Labels only. Stored values, routes, tRPC and server code stay as they are.

Check:

- This grep finds nothing outside tests and code comments: `grep -rnE "Cloudflare|Our machine|Managed Agents|[Mm]anaged agents|[Ss]ession stops|one run may|This runtime|new runtime|>Runtime<" apps/web/src/components apps/web/src/routes --include=*.ts --include=*.tsx`. On this commit it hits exactly the sites in finding 1, plus three code comments.
- `dry-run-logic.test.ts`, `agent-form.test.tsx`, `profile-logic.test.ts`, `move-agent-logic.test.ts` and `map-logic.test.ts` assert the new strings.
- Browser: Start blank, pick Cloud, and the dry run note says Cloud. Open Edit on a machine agent and read "Runs on".
- `bun run check && bun run test && bun run build` pass.

## Steps for Dom

- Deploy the Worker before the daemon, as the NV.4 record says.
- After both are deployed, ask a question from a machine agent, start a second task for it while the question waits, then answer. The first task should continue once, in the same conversation.
- Run `cd apps/web && bun run retitle-sessions --remote` as a dry run, then again with `--apply`.

## Verdict

Not clean: 1 must-fix.
