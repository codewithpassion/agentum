# TX.2 review

## Verdict

Round 1, commit 6a8ea6fa: must-fix, two items.
- `fireDueTeams` let a team that could not start (workspace over its weekly limit, a dream already running) use up the tick's three turns, so three such teams starved every other team.
- The spend page's weekly totals left team dream spend out, while the cap counted it.

Round 2, commit 7c2d6eb4: clean. The tick files a refused start under a new `skipped` list that does not count against its turns. `buildSpendTable` returns `teamCentsByWeek`, includes it in `totals`, and the table shows a "Team dreams" line.

## Decisions made in this task

- Team memory is `teams/<slug>/memory/`, the same files as an agent's. `library/memory-paths.ts` now treats it as a memory folder, so a run cannot write it and `memory/files.ts` (`commitFolderFiles`, `loadFolderMemory`) is still the only caller of `writeMemoryFiles`. The Everyone team has no folder, so it keeps no team memory and does not dream.
- The room digest is `teams/<slug>/memory/digest.md`, a plain-text file beside the notes that the codec never reads. It rides the same library call as the notes, so undo restores it. The dream writes it last, so the run's `result_version` is the digest's version exactly when it wrote one; undo reads that to know.
- The team dream never reads a private note. It holds no `dream` flag, asks for no private path, and reads only members whose rules have `shareWithTeam` on. Tests assert that no blob key under `/private/` or under a non-sharing member is touched, that no secret text reaches a prompt, a note, the diary or a notice, and that private files keep their bytes and versions. There is no "approve sharing" path: a private note stays private.
- Room posts come only from topics with no `inbox_thread_members` rows, never from the team diary topic, never from the system. Limited topics stay out of the digest and the diary.
- Conflicts become one `dream_questions` row for the team owner, with the holding member's id stored in each option. Answering keeps one note, edits every other member's disagreeing note to the kept text (forgets a second note of the same member), and writes through the files layer as the person who answered, because the team owner need not own each member. Those rows carry no `dream_run_id`, so undoing the dream never reverts a person's decision. Questions already open are not asked again.
- A note three or more members hold, at confidence 0.7 or more, becomes one team note and the member copies are forgotten, in one library call. A lift is refused when its text trips the secret check or the workspace never list. A team with an equal note already adds nothing and only forgets the copies.
- Spend: a team dream is a `dream_runs` row with no agent. `SpendRow` has `agentId: string | null` and an optional `teamId`; a team row counts toward the workspace's week and cap and toward no agent. The dream is refused when `workspaceOver` says so, and calls `enforceWorkspaceCap` when it ends.
- Hand-off friction: `requests.open` needs a live run and `run_requests.run_id` is NOT NULL, so a dream cannot open the proposal itself. With a lead and an owner, the dream posts a request in the "Team diary" topic and wakes the lead as the team owner; the lead then calls its own `team_propose_change`, and the member's owner approves. With no lead the finding is only a diary line.
- `inbox.postNotice` (system only) posts the diary as the lead, or as `system` when the team has no lead, without waking anyone by mention. `roomDigest` fills the catch-up slot of `buildWakeInput`.
- The tick starts a team dream when some member's dream finished after the team's last dream began and no member's dream is running or due. The claim is one `insert ... where not exists` statement.
- Migration 0060 and the schema are untouched.

## Nits left

- `dream.ts` `fireDueTeams` runs about five queries per candidate team each minute. Fine at today's scale.
- A team whose members dreamed long ago is due at once the first time, at any hour of the day.
- `answer.ts` does not check that a holder still shares with the team, and two simultaneous answers can both write the files.
- A lifted team note copies the first holder's `source`, which another member may be unable to open.
- The `spend-table.tsx` caption still says "Spend per agent".
- `memorySection` in `memory/prompt.ts` was extended additively with a team block. `loadPromptMemory` and `libraryMemoryReader` are unchanged.

## Beyond the scope

- TX.6 posts the diary to Slack at 08:00 from `dream_runs.diary`. The dream already posts it in the room at dream time, so SL.3's mirror may send it to Slack as well. TX.6 should pick one.
- Team dream spend is one "Team dreams" line, not split by team.
- No web UI lists team dreams or shows their diary yet; `dream.get`, `dream.undo`, `dream.runTeamNow` and the Needs you question card work.

## Steps for Dom

None. Nothing here needs an account or a dashboard.
