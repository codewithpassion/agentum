# DR.16 review

Round 1 (e61d3683): clean. The reviewer found no must-fix in the code. Its one conditional must-fix was the real-model run, which is recorded below.

## Real-model run

Two conversations that disagree (supplier invoices paid on Thursdays, then on Fridays) went through one full dream on `claude-haiku-5-5`, in the dream test world (in-memory SQLite, no deployed database). The key came from `apps/web/.env.local` through a shell variable and was never written to a file, the log or the commit. The dream added both notes and raised one open question naming both new note ids, workspace-shared, which is the row the desk lists under Needs you. Diary usage row: 1,880 input and 647 output tokens, $0.0005115. A second dream with an unrelated message added one note, asked nothing, and left one question row. The desk card itself was not rendered in a browser.

## Nits left

- A held batch (ask_first or outside evidence) still lets reconcile judge the new notes, and a conflict between an existing note and a new note can claim the existing note's id before a later conflict between two existing notes. That dream then asks neither, and the next one does.
- The run test "an answered question settles its group" leaves one note after the answer, so the dream-only skip is covered by the reconcile unit test, not by the run test.

## Ideas beyond the scope

- A held batch with two disagreeing adds raises no question, and once approved both notes are dream-written, so reconcile never questions them. A question could be raised when the batch is approved.
- Answering a question leaves the kept note dream-written, so a later conversation that repeats the losing fact is asked about again. Marking the kept note as person-written on answer would count a person's choice for the "person wins" rule.
- Open questions are deduplicated only on the exact same set of ids, so a third candidate can raise an overlapping question while the first is still open.

## Steps for Dom

None.
