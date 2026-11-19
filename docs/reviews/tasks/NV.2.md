# NV.2 review: Plain words for where an agent runs

## Verdict per round

- Round 1, d7a5f40b: clean after 0 fix rounds. No must-fix findings, five nits.

## What changed

- `RUNTIME_NAMES` in `profile/profile-logic.ts` holds the three names: Cloud, Anthropic cloud, My computer. The Runs on card, the runtime line in the Edit form and the Move agent dialog all read from it. Stored runtime values are unchanged.
- In `agent-form.tsx`, Environment, Network access, Turn limit and the raw model id sit in one closed "Advanced" section (`profile/disclosure.tsx`). The cloud model select, the machine select, Name, Instructions and the runtime line stay visible.
- `dictation-rollout.test.tsx` gets `cancelAnimationFrame` in its happy-dom global list, because the Radix Collapsible calls it on unmount.

## Nits left

- `runs-on-card.tsx:44`: the card's "Advanced" button opens the panel, and the form inside now has its own closed "Advanced" section. Two things carry the same name.
- `profile-logic.ts:57-63`: "Runs on Cloud" and "Runs on My computer: laptop" have a capital mid-sentence. The profile header and map inspector show the same line.
- `move-agent-logic.ts:21`: "A conversation that ran on Cloud before may pick up there" would read better as "ran in the cloud".
- `agent-form.test.tsx:82`: `toContain("Name")` proves nothing about the model select, since Name is always there. The `id="agent-model"` check in the same test does the work.
- `runs-on-card.test.tsx:28`: `toContain("Cloud")` also passes on "Cloudflare". The newer test in the file checks that "Cloudflare" is gone.

## Browser proof

Pass at both sizes with no console errors or failed requests. Report and screenshots: `docs/reviews/tasks/NV.2/browser.md`. The verifier could not test a My computer agent because the local workspace has no machine.

## Ideas beyond the scope

- The Start blank "Runs on" chips still say "Cloudflare" (`builder-logic.ts:160`), and so does Settings, Model providers. The Anthropic cloud card text still says "Managed Agents".
- `builder-logic.ts` (the Start blank "Runs on" chips), `dry-run-logic.ts`, `map-logic.ts` and the landing page still say "Cloudflare" and "Our machine". They sit outside the three files the task names.
- The runtime stays a read-only line in the Edit form. Changing it is the Move agent dialog, which carries the blockers (no Anthropic key, no machine). A real three-way control in the form would need those blockers.

## Test status

`apps/web/src/server/live-artifacts/guest-execution.test.ts` fails on a clean `main` as well (ECONNRESET from the node runner). It is not part of this task.

## Steps for Dom

None.
