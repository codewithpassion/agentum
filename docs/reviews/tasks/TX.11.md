# TX.11 review: the seeded Launch team can dream

## Rounds

1. Commit 9be0703b: must-fix. A rerun left a Launch team that an older seed wrote with no folder as it was, so `runTeamNow` still refused it.
2. Commit ea7364bc (the fix): clean. A rerun now sets `folder_path`, makes the `teams` and `teams/launch` entries and, through `addMember`, grants the agents write access. A test covers it.

## What changed

`scripts/dev/seed-slack-room.ts` makes the Launch team through `teams.create` and adds members through `teams.addMember`, so it gets `teams/launch` and its agents' grants. The seed principal is an admin so a rerun for another Clerk user can add members. The seed test runs `runTeamNow` on the seeded team and checks the folder and the three grants.

## Nits left

- `giveFolder` does not refuse a file sitting at `teams` or `teams/launch`, as `teams.create` does.
- An archived Launch makes the seed fail on the slug instead of reusing the team, because `teams.list` hides archived teams.
- A rerun with another `--clerk-user` adds that user as a member but leaves the first user as owner.
- Seeded agents now get Launch as their home team through the first-home rule. The old seed set none.
- The repair test checks rows, not a `runTeamNow` call on the repaired team.
- The script now declares `teams` and `library_entries` columns by hand, two more copies to keep in step with the schema.

## Ideas beyond scope

- A `teams` service call to set the folder of a team that has none, so the script need not write it.

## Browser steps skipped

None in this task's check.

## Steps for Dom

None. Rerun `bun scripts/dev/seed-slack-room.ts` to repair an existing local Launch team.
