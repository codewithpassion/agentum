# NV milestone gate review, round 2

Commit 3ea29fa3 on main. Range `nv-start..3ea29fa3`, judged against the NV parts of `docs/v4/build-plan.md` (Decisions, Vocabulary, NV overview), the five task files NV.1 to NV.5, the checkout's CLAUDE.md and "Rules that are easy to break" in `docs/HANDOVER.md`. Round 1 is `docs/reviews/NV-1.md`. The range also holds RH, KY, JB, ME, DR, TM, SP, FR and FX merges. I judged those only where they touch NV's words, titles or the parked-question path.

## Verdict

Must-fix: 1.

Round 1's must-fix is resolved. NV.5 merged as 311c1b3d and changed every site that finding 1 named. The NV.5 check grep now hits only two code comments (`move-agent-logic.ts:17`, `secrets/status.ts:12`), which the task allows. The tests named in the check assert the new strings, and NV.5's own browser record covers each flow at 1280x800 and 390x844. I did not rerun the browser. NV-1 nit 8 (the capital "My" mid-sentence) is fixed too: `runtimeWords` now says "Runs on my computer: <name>", and the Edit sheet shows the bare name under the "Runs on" label.

The new must-fix is the same kind of gap, in places round 1 did not search. The task page header, which `/threads/$sessionId` and the room's Chat tab both render, still names runtimes with the old words: "Managed agent" for an Anthropic cloud agent and "A machine" for a machine agent with no machine name (`components/task/task-logic.ts` `RUNTIME_LABELS`, shown by `task-page.tsx:575`). That code dates from V2.11, before NV, and round 1's grep missed it because it searched only the plural "[Mm]anaged agents". The builder also still says "No runtime is available." The Vocabulary table marks the runtime words as done in NV.2, so this is the same reason round 1 gave for its must-fix.

The later merges do not break NV. After NV.4 merged, the only changes to the files on the parked path are ME.5's memory loading in `runs/launch-context.ts` and `runs/machine-claim.ts`, plus ME.8's held notes in `desk.ts`. None of them touch parking, leases or the follow-up run. No file under `apps/agentum/src` changed after NV.4. RH.2's roster builds its status line from `runTitleText`. It checks an open question (needs you) before a running task, and it counts only `running` runs as working, so a parked run reads honestly on the card. The NV.3 title files (`mail-title-text.ts`, `sessions.ts`, the retitle script) have not changed since NV.3 merged. The room tab labels (Chat, Work, Files, Knows, Keys, Jobs, Settings) follow the plan's words.

## Checks run

- `bun run check`: passed.
- `bun run build`: passed, and `grep -rl drizzle apps/web/dist/client` finds nothing.
- `bun run test`: all 14 turbo tasks passed, but every one was a turbo cache hit, so I ran `turbo run test --force --continue` again. `@repo/services` passed 4626 tests and `web` passed 4696 tests, with 0 failures in each. Every other package passed too. In `agentum-rs`, one test failed under turbo, `the_session_bus_listens_where_the_environment_says`, with "the state directory path is too long for a D-Bus socket". Turbo does not pass this session's long `TMPDIR` setting through, so the temp dir path ran past the socket limit. `cargo test` run directly with `TMPDIR=/tmp` passed all 205 tests. The NV range does not touch `src/desktop/apps.rs`, so this is the host, not NV. `bun test scripts` passed 402 tests.
- The NV.5 check grep finds only the two code comments above.
- NV.1's check, `grep -rn "Run [0-9] of\|New task" apps/web/src --include=*.tsx`, finds nothing outside tests.
- Swept `apps/web/src` outside `server`, `components/ui` and tests, plus `packages/db/src/shared.ts`, for visible "runtime", "session", "thread" and "run" used as a noun. What remains is in the findings below, apart from sign-in "session" strings, the verb "run", Slack's own "Slack thread", and JB's "Last run" on jobs. The public landing page says "Runs on Cloudflare Workers" and "Claude Managed Agents", which name the host and Anthropic's product, so I left them out.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | must-fix | The task page header shows "Managed agent" for an Anthropic cloud agent and "A machine" for a machine agent with no machine name. It shows "Fake runtime" for the dev fake runtime, where the Map says "Test runner" (`components/task/task-logic.ts:112-117` `RUNTIME_LABELS`, used by `runsOnText` in `task-page.tsx:575`). The builder says "No runtime is available. Add a provider key or a machine in Settings." under the "Runs on" label (`builder/start-blank.tsx:78`, `builder/draft-card.tsx:407`). It shows whenever the workspace has no usable provider key and no machine. | NV.1/NV.2 gap | New task NV.6, scope and check below |
| 2 | nit | Explanatory notes still say "machine agent(s)": the secrets notes ("Machine agents receive env secrets...", `sheets/secrets/runtime-notes.tsx:17`), the secrets sheet ("machine and Linux VM agents", `sheets/secrets.tsx:101`) and the peer trust note ("A machine agent can run shell commands on its computer.", `connections/connections-logic.ts:138`). | NV.2 | Fold into NV.6. Say "an agent on My computer" |
| 3 | nit | The secrets notes and the allowed-hosts help say "Isolate agents" and "an isolate agent" (`runtime-notes.tsx:5,11`, `secrets/allowed-hosts-field.tsx:31`, `secrets/edit-hosts-dialog.tsx:58`). "Isolate" is the Environment choice under Advanced, so the word is visible in the product, but these lines read as a fourth kind of agent. | NV.2 | Optional in NV.6, for example "Cloud agents in the isolate" |
| 4 | nit | `runtimeWords` lowercases `RUNTIME_NAMES.machine` in code, so the sentence depends on that label lowercasing cleanly. The NV.5 record lists this. | NV.5 | Known |
| 5 | nit | The map's `RUNTIME_SHORT` repeats `RUNTIME_NAMES` by hand for three entries, and `task-logic.ts` keeps a third copy (finding 1). The third copy is the one that drifted. | NV.5 | Have NV.6 read `RUNTIME_NAMES` in `task-logic.ts` and `map-logic.ts` |
| 6 | nit | The Anthropic cloud note in the Edit sheet starts "In Anthropic's cloud, not on one of your machines." right under the value "Anthropic cloud". The NV.5 record lists this. | NV.5 | Known |
| 7 | nit | NV.5's check named Start blank for the dry run note. The note only shows in the builder's draft review, and it was verified there. The task log records the correction. | NV.5 | Known |
| 8 | nit | NV-1 nits 2 to 7, 9 and 10 carry over unchanged. Their files (`mail-title-text.ts`, `sessions.ts`, the retitle script, the parked-run catch blocks) have not changed since NV.3 and NV.4 merged. | NV.3/NV.4 | Known, as in NV-1 |

## Task for the must-fix

### NV.6: runtime names on the task page and in the builder

Size XS, executor claude. Files: `components/task/task-logic.ts` (lane `web-thread`), `components/agent/builder/start-blank.tsx` and `draft-card.tsx` (lane `web-builder`), and the three notes in finding 2 (`web-agent`, plus `components/connections`). No server code.

Scope:

- `components/task/task-logic.ts`: build `RUNTIME_LABELS` from `RUNTIME_NAMES` in `components/agent/profile/profile-logic.ts`, so the header reads "Cloud", "Anthropic cloud" or "My computer" when the machine has no name. Name `fake` "Test runner", as the Map does.
- `builder/start-blank.tsx` and `builder/draft-card.tsx`: replace "No runtime is available." with wording that does not say "runtime", for example "Nowhere to run it yet. Add an Anthropic API key or a machine in Settings."
- Finding 2: replace "machine agent(s)" with "agents on My computer" in `runtime-notes.tsx`, `sheets/secrets.tsx` and `connections-logic.ts`.
- Optionally do the same for `map-logic.ts` `RUNTIME_SHORT` (finding 5), keeping its strings as they are.
- Labels only. Stored values, routes, tRPC and server code stay as they are.

Check:

- This grep finds nothing outside tests and code comments: `grep -rnE "Managed agent|\"A machine\"|Fake runtime|No runtime|[Mm]achine agents?\b|machine and Linux" apps/web/src/components apps/web/src/routes --include=*.ts --include=*.tsx`. On 3ea29fa3 it hits the sites in findings 1 and 2, plus the comment at `move-agent-dialog.tsx:59`.
- `task-logic.test.ts` asserts `runsOnText` for `managed` ("Anthropic cloud"), for `machine` with no machine ("My computer") and for `cloud` ("Cloud").
- Browser: open a task of an Anthropic cloud agent at desktop width, and the header line says "Anthropic cloud". In a workspace with no Anthropic key and no machine, open Start blank and read the new line under "Runs on".
- `bun run check && bun run test && bun run build` pass.

## Steps for Dom

These carry over from NV-1. Nothing new needs Dom's accounts.

- Deploy the Worker before the daemon, as the NV.4 record says.
- After both are deployed, ask a question from a machine agent, start a second task for it while the question waits, then answer. The first task should continue once, in the same conversation.
- Run `cd apps/web && bun run retitle-sessions --remote` as a dry run, then again with `--apply`.

## Verdict

Not clean: 1 must-fix (finding 1, task NV.6).
