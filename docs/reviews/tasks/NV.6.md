# NV.6 review

## Verdicts

Round 1 at 9064ae9: clean (Opus reviewer). No must-fix findings. Checks run by the reviewer: grep from the task file, `task-logic.test.ts`, `bun run check`, `bun run test`, `bun run build`.

Browser proof: pass, see `docs/reviews/tasks/NV.6/browser.md`. Flow 1 is desktop-only by design, because the task header's meta line is hidden below `md`.

## Nits left

- `start-blank.tsx:78` and `draft-card.tsx:407`: the new line names only an Anthropic API key, but a workspace OpenRouter key also makes Cloud available. The wording is the one the task suggests.
- `connections-logic.ts:138`: "run shell commands on it" could read "on that computer".
- `map-logic.ts:62`: `runtimeShort` is now a one-line wrapper around `RUNTIME_NAMES`; the single caller could index the map directly.

## Ideas beyond scope

- The task page hides the "Runs on" line at phone width. Showing the runtime there would be a separate UI decision.
- A Clerk request returns 400 during local dev login. It is outside this task and was not traced.

## Steps for Dom

None.
