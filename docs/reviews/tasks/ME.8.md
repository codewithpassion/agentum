# ME.8 review: held notes in Needs you, learned count on the card

Implementation by Codex, reviewed by Opus.

## Verdicts

- Round 1 (906f35f8): not clean. One must-fix: a private held note went to the agent's owner and backup, who can neither see nor decide it.
- Round 2 (bc833540, fix commit only): clean. The note now goes to its `userScope` person alone, with no backup step (`DeskCard.forUserId`, set in `desk.ts`, used in `rail.ts` `candidate()`).

## Nits left

- `desk.ts`: held rows with a `groupId` (merges and their absorbed forgets) are not filtered out. No code writes held merges yet. When DR does, each would show as several cards that `memory.decide` refuses to decide from the card.
- `desk.ts`: a held `forget` or `edit` uses the same "wants to remember something" heading, and the detail for a forget is the text to forget.
- `roster.ts`: `learnedCount` counts every applied row of the last seven days, including `forget` rows, each row of a merge, and agent or dream changes that the Knows tab hides at a quiet learn level. It can differ from the Learned this week list.
- Held notes on archived agents still appear, as library conflicts and wiki suggestions do.

## Ideas beyond the scope

- Show the action (add, edit, forget) on the held note card.
- Share one counting rule between `learnedCount` and `learned-logic.ts`.
- Send a private note to its person when that person has left the workspace.

## Steps for Dom

None.

## Test notes

`packages/services/src/runs.test.ts` "an hour of never-claimed runs stays bounded" takes about 59 s alone against a 60 s timeout and fails under load (load average 15). `apps/web` `guest-execution.test.ts` fails alone on this loaded host. Neither touches this change.
