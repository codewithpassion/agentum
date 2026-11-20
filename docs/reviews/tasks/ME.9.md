# ME.9 review: memory walkthrough on all three runtimes

Findings of the walk: `docs/reviews/ME-e2e.md`. Browser proof: `docs/reviews/tasks/ME.9/browser.md` with screenshots (round 1 numbered desktop 1 to 30 and phone 1 to 24, round 2 from desktop 31 and phone 25).

## Verdicts

- Browser round 1 (fresh verifier, commit 514b4af3): every flow passes functionally at both sizes. Literal verdict FAIL: the plain member's direct private-file URL (a deliberate 404), server-side "tRPC desk.rail failed" lines in the dev log whose cause is not shown, and two forwarded `[error]` console lines. It also found the held-note item page showed no note text (fixed in 8ad4897c).
- Browser round 2 (fresh verifier, commit 8ad4897c): the fix works at both sizes, and the Remember and member-Library flows re-pass. Literal verdict FAIL for one console error, a Clerk `POST /v1/client/sign_ins` 400 that `/api/dev-login` produces when the browser is already signed in. No memory page returned a 4xx apart from the labelled denial probe, and the server log showed no `desk.rail` failures.
- Code review round 1 (d6890aa7): not clean, two must-fix. The fake runtime's memory load could leave a claimed run uncompleted if the launch context threw. ME-e2e.md cited a round 2 that was not committed. Both fixed in 345a6b3d.
- Code review round 2 (345a6b3d, fix commit only): clean after 1 fix round.

Why the browser verdict stays FAIL on its literal rule: the remaining items are the sign-in tool's 400 and a deliberate denial, neither a memory defect. A third verifier would see the same, so none was run.

## Nits left

- Test "a run whose memory cannot be read still echoes" would pass on the old code too, because `libraryMemoryReader` already swallows read errors. The launch-context and getter tests carry the guard. A database error inside `buildLaunchContext` is untested.
- `desktop-37.png` is byte-identical to `desktop-34.png` (the "after Reject" shot is really the post-Approve one), so on desktop only the text count supports the Reject claim. Phone-32 is separate. In round 2's phone A2 text, `phone-33` is the message menu, not the dialog (the index is right).
- ME-e2e.md says the fake "repeats" notes where a real model uses them. The fake prints every loaded note word for word, private ones included, to the person the run acts for.
- The plain member sees Rename, Move and Delete on memory files in the Library, and Edit and Forget on notes.

## Beyond the scope

Proposed tasks in ME-e2e.md: the cloud follow-up message on the scripted model comes back empty (`scripts/e2e/cloud.ts` fails at its second run), the Needs you drawer row repeats the heading and never shows the note, and a decision on how a person gets a private conversation (only Slack DMs make one today).

## Test run on the branch

`bun run check && bun run test && bun run build` passed at d6890aa7 with no failures. They are re-run after the merge of main, see the log line in the task file.

## Steps for Dom

- Managed Agents: the same memory check on staging with the staging Anthropic key.
- After deploy, check a private note once on staging with two real members.
- Decide the private-conversation switch (ME.13 in ME-e2e.md).
