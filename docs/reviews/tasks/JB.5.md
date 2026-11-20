# JB.5 review record

## Verdicts

- Round 1, opus, on d978d3fe: clean. No must-fix.

## Nits left

The reviewer's 11 nits. Items 5 to 10 (verdict wording, desktop-only re-check, rail polling claim, JB.6 and JB.7 scope gaps) were fixed in `docs/reviews/JB-e2e.md`. Left alone:

- `jobs-panel.tsx` run now: if `router.invalidate()` rejects, the panel shows an error after the success toast although the run started. Calling it after the try/catch would avoid that.
- The comment above the invalidate says "the roster" reads route data. Only the room's Work tab needs it, since `/home` reloads on every visit.
- `invalidate` and `load` run one after the other while Run now stays busy. They could run in parallel.
- No component test for the invalidate call.
- phone-4.png and phone-6.png are byte-identical. That fits "card unchanged", but the pair cannot show a before and an after by itself. The text in browser.md carries the comparison.

## Ideas beyond the scope

- JB.6 (card wording for a finished run) and JB.7 (a manual run counts as fired) are written up with scope and check in `docs/reviews/JB-e2e.md`.
- Reset the describe box after Save job (noted in JB.4 too).

## Steps for Dom

- Try "Every Friday, summarise support tickets for me" on the Jobs tab with a live Anthropic key. The drafter has only met a fake model and a browser stub.
- Decide JB.6 and JB.7.

## Checks

Browser proof: `docs/reviews/tasks/JB.5/browser.md`, verdict pass at both sizes, run by a fresh verifier. `bun run check` and `bun run build` pass. `bun run test` passes except two host-load timeouts that also fail or run slow alone while the host load average is 15 to 17: `apps/web` `guest-execution.test.ts` (known flake until FX.1; failed alone too, at 97 s) and `packages/services` `runs.test.ts` "an hour of never-claimed runs stays bounded..." (62 s in the full run, passes alone in 58 s; it also timed out in the full run before any JB.5 change). Neither touches Jobs.
