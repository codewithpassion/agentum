# NV.5 review: finish the runtime and task words in the agent flows

## Verdicts

- Round 1 (a5b4166): not clean, 2 must-fix. The Edit sheet showed the label "Runs on" over a line that also began "Runs on". "Runs on My computer: <name>" kept its capital "My" mid-sentence (NV-1 finding 8), which I had wrongly read as already fixed.
- Round 2 (1e01775, fixes only): clean. `runtimeName()` now gives the bare name under the label, `runtimeWords()` says "Runs on my computer: <name>", and the managed description starts "In Anthropic's cloud".

## Browser check

Pass at 1280x800 and 390x844, no console errors or failed requests in the flows. Report and screenshots: `docs/reviews/tasks/NV.5/browser.md`. The task's Check says Start blank shows the dry run note after picking Cloud. It does not. The note appears in the builder's draft review (Describe it, or a template), and that is where it was verified.

## Test runs

- `bun run check` and `bun run build` pass.
- `bun run test` stops on the known load flakes: `packages/services` `runs.test.ts` ("an hour of never-claimed runs", 60s timeout) and `apps/web` live-artifacts `guest-execution.test.ts`. Run alone, `runs.test.ts` passes (174 pass), and `guest-execution.test.ts` plus `room.test.ts` pass (2 pass). The rest of `apps/web` runs 4687 pass.
- `cc` on PATH is `~/.local/bin/cc` (command-centre), which shadows the C compiler and breaks `cargo test` in `apps/agentum`. Putting `/usr/bin` first on PATH fixes it.

## Nits left

- `agent-form.tsx`: the managed description "In Anthropic's cloud, not on one of your machines." still echoes the value above it.
- `runtimeWords` lowercases `RUNTIME_NAMES.machine` in code, so the sentence depends on that label lowercasing well.
- No test renders the form, room header or map inspector with a named machine. Only `profile-logic.test.ts` checks the machine sentence and name.
- `map-logic.ts` `RUNTIME_SHORT` repeats `RUNTIME_NAMES` by hand for three entries.
- On a phone, the map inspector line "Runs on my computer: <name>" is cut off visually (full text present). Not caused by this task.
- The comments at `secrets/status.ts:12` and `move-agent-logic.ts:17` still say "managed agents" and "Cloudflare". The task allows code comments.
- Scope item "Fix 'ran on Cloud before'" needed no change: `moveNote("cloud")` already read "A conversation that ran on Cloud before...". The new test pins it.

## Beyond scope

- "No runtime is available." still shows in `builder/start-blank.tsx:78` and `builder/draft-card.tsx:407`.
- The secrets notes still say "Isolate agents" and "Machine agents" (`sheets/secrets/runtime-notes.tsx`), which are the old runtime words.

## For Dom

Nothing needs your accounts or dashboards.
