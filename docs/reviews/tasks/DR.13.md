# DR.13 review

## Verdict

Round 1 at c5660623: clean, no must-fix.

## Browser steps skipped

None named in the task's check. No browser step was run.

## Nits left

- `scripted-model.ts`: a dev build always uses the scripted fetch, even when the workspace has a real key, so `bun run dev` cannot run a real dream.
- The scripted extract returns the same two notes whatever the evidence says, so a second Dream now on one agent can add duplicates.
- The scripted reconcile asks about the first two person-written notes per prompt, so several kind groups could give several questions.
- The request body is read with a type assertion, not narrowing.
- `kindOf` falls back to "condense" for an unknown prompt, so a new call kind would not fail loudly in dev.
- `CLAUDE.md` lists what `devFakeRuntime` gates but does not mention the dream's scripted model.
- The seed script alone does not give the question and held batch: "Ask me first" and two disagreeing notes are still added by hand (the comment in `seed-dream.ts` says so).

## Beyond scope

- An opt-out so a dev workspace with a real key can run a real dream.
- A script that adapts its notes to the evidence.

## Steps for Dom

None.
