# DR.5 review: Dream promotes repeated procedures to skill proposals

Built by one Codex job (commits 547fffe6, 1dd09601), then reviewed by Opus.

## Verdicts

- Round 0 at b868d369: must-fix. A procedure drawn from a person's private conversation was filed as a proposal the whole workspace could see. Only the diary line was generic.
- Fix 1 (2135b777): private-scope items no longer reach the promotion judge.
- Round 1 at 2135b777: must-fix. Outside-scope items from a person's private session keep their `userId` and still got through.
- Fix 2 (71450177): any item with a `userId` is dropped too, and the judge is not called when nothing is left.
- Round 2 at 71450177: clean.

Also hardened by the dispatcher: `skillsStore.proposeForAgent` only accepts the in-process dream principal (`dream: true`), so a person or key cannot author as an agent.

## Nits left

- The rejected-title guard sees only rejections in the current dream window. A rejection from an earlier window blocks a refile only while the owned skill name matches; a new name and title for the same procedure would be filed again.
- `skillsStore.list` omits deleted skills, so a rejected-then-deleted skill's name is free again.
- "3 distinct evidence ids" is not "3 runs": several messages of one run or session count separately, and `request` and `memory_change` items can be cited.
- A failed promotion model call fails the whole dream, so a good memory plan is lost with it (deliberate, tested).
- The model sees all workspace-scope items and could put text from them in a title while citing others; outside (mail, peer) evidence is not held the way the memory plan holds it.
- The diary is stored first and updated after filing, so a failed update leaves a filed proposal out of the diary.
- On a held memory batch, the "Proposed a skill" line follows the held summary and can read as held too.
- Undoing a dream leaves its skill proposal pending.
- The outside-plus-`userId` case is tested only in the step test, not through `collect` end to end.

## Ideas beyond scope

- Group evidence by run or session and require three runs.
- Read rejected proposals for the agent from the skill store instead of the dream window.
- Hold promotion drafted from outside evidence, as memory does.

## For Dom

Nothing. No account or dashboard step.
