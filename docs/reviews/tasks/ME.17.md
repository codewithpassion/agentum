# ME.17 review

Verdict: clean after 1 fix round.

## Rounds

- Round 1 at 433761e1: must-fix. `dream.answer` forgets the unchosen shared notes as the answering person, so a non-owner would be refused with nothing covering it. Fixed in 53a29801 with a test: a member's answer is refused, both notes stay and the question stays open.
- Round 2 on 53a29801: clean.
- Browser proof: pass at desktop and phone, see `docs/reviews/tasks/ME.17/browser.md`. Its console errors came from the verifier's own seeding (a malformed seed id, an undo of an edited note, SQLITE_BUSY from direct `sqlite3` writes), not from the app.

## Rule as built

A person (user principal) changes an agent's shared notes and shared held or applied changes (edit, forget, decide, undo) only as the agent's owner (owner, else creator) or an org admin, using `requireAgentOwnerOrAdmin` as the Keys rule does. A refused call throws `ForbiddenError` before anything is written. A person's own private note or change is theirs to change. A run keeps to the learn level and is not checked. Adding a shared note stays open to any member (the task does not list add).

## Nits left

- A non-owner still sees "Waiting for you" on a shared held row.
- The owner-only line on the notes list shows to every non-owner, even when all notes are private. The Learned list shows its line only when a row lacks Undo.
- `learned-slot.tsx` repeats the `canChangeRules` call from `knows/index.tsx`.
- `edit` runs the secret check before the owner check, so a non-owner whose text looks like a secret gets the secret error.

## Ideas beyond the scope

- The Needs you rail cards for a held agent note (`memory_note`) and for a dream question still go to non-owners, and rail escalation sends them to the agent's backup. The service now refuses both for anyone who is not the owner or an admin, so those cards fail safely with an inline error but are a dead end. Fixing it means deciding whether the backup counts as an owner, then narrowing `desk.ts` `railSources` (as `heldBatchesFor` does for dream batches) and the rail's escalation tests.
- At the `tell_after` level a member can chat with the agent and have its run edit or forget a shared note the member cannot change directly.
- A member can add a shared note and then cannot edit, forget or undo it.

## Steps for Dom

- Decide whether an agent's backup owner counts as an owner for notes (and for keys, which use the primary owner only). The rail follow-up above depends on it.
