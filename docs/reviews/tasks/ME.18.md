# ME.18 review

Verdict: clean after 0 fix rounds.

## Rounds

- Round 1 at c0bd4e65: clean. No must-fix.

## Rule as built

An agent's owner (owner, else creator), its backup owner and an org admin can decide a held shared note (`memory.decide`) and answer a dream question (`dream.answer`, which forgets the unchosen notes through `memory.forget` with `asDecision`). Edit, undo and a plain forget of a shared note stay owner-or-admin, so the backup gains no more than deciding. A plain member is refused. `desk.ts` `decidableAgentIds` limits the shared held-note and dream-question cards to those three groups, and a person still sees their own private note and question. The rail's owner-then-backup escalation is unchanged.

## Nits left

- `decidableAgentIds` counts only `member.isAdmin` as admin, while `requireAgentDecider` also counts an admin API key. `heldBatchesFor` does the same.
- `forget(..., { asDecision: true })` is a public option on `MemoryService`. Only `dream.ts` passes it.
- No rail test shows a shared dream question escalating to the backup after the delay. Held notes are covered.
- The desk test "the backup gets a held note and a dream question at once" reads as no escalation delay. It checks desk sources, which have none.

## Ideas beyond the scope

- A dream's held batch (`dream.decide`, the `dream_held` card, `heldBatchesFor`) is still owner-or-admin. It is held notes in bulk, so the backup who can approve a lone held note cannot approve a dream's batch. Letting the backup decide it means changing `ownerSession` in `dream.ts` and the filter in `dream/held.ts`.
- `dream.answer` has no permission check of its own and relies on `forget` refusing. A `not_found` from an already-forgotten note is swallowed, so a plain member could close a shared question whose unkept notes are already gone (from ME.17).
- The spend-pause card still uses the owner-or-creator rule without the backup.

## Steps for Dom

- Decide whether the backup should also decide a dream's held batch (the idea above).
