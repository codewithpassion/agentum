# TM.2 review: teams service

Implemented by Codex in two commits (tests first, then the service), reviewed by Opus.

## Rounds

- Round 1, at 7d15cb94: must-fix. `removeMember` refused an archived team, so its members and their `agent_library_access` grants on `teams/<slug>` could never be removed.
- Round 2, at de1ec8d6 (fix only): clean. `removeMember` now works on an archived team. Update, addMember, setLead and setRules still refuse one. The literal `"everyone"` became `EVERYONE_TEAM_SLUG`.

## Decisions the task left open

- Reads need any user in the workspace. Writes need an admin or the team's owner. A create needs an admin, or the caller becoming owner. A read-only API key or OAuth client cannot write.
- An agent's first team becomes its home. `isHome: true` moves the home. A person is never home. Removing a home member promotes the lowest-id live team.
- Removing the lead clears the lead. The "Everyone" team has no folder, no grants, and cannot be archived.
- Archiving keeps members, folder and grants. Only `removeMember` still works on an archived team.
- `roster.list` already read `teamId` and `isLead` from the tables (TM.1), so it needed no change. Tests now cover it with a real team.

## Nits left

- Archiving an agent's home team does not move the home to a live team, so the roster shows `teamId: null` until the member is removed or re-homed.
- When only archived teams are left, `promoteHome` makes an archived team the home, which the roster hides.
- The write guard refuses only read keys and read OAuth clients. A `desk` key passes, though no route lets it reach this service today.
- `setLead` checks membership and writes the lead in two statements, and `addMember` checks that the agent is active outside the atomic write. Both lose a race only against a concurrent change by an admin or owner.
- Adding an agent raises a manual `read` grant on the team folder to `write`, and removing the agent deletes it.
- Team grant changes write no `library.access` audit event.
- User member ids and `ownerUserId` are not checked against the organisation's people.
- Test gaps: cross-workspace `teamId` on addMember, removeMember, setLead, setRules and archive; removing a user member; an agent grant over an existing grant; lead cleared on an archived-team removal; one test name still says archive "blocks changes".

## Ideas beyond the scope

- Refuse a person handle that equals an agent slug or a broadcast word such as `everyone` or `here`, so an `@handle` mention is never ambiguous.
- Audit team grant changes as `library.access` events.
- Revoke member grants on archive, or add an unarchive.

## Steps for Dom

None. No migration, secret or dashboard change.
