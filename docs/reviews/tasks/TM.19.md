# TM.19 review

Round 1, commit b409c958: clean. No must-fix items.

## Nits

Fixed after the review: a redundant test block that passed for the wrong reason, and a doc comment that left out admins.

Left as they are:
- `removableFrom` repeats the agent select that `activeAgent` runs, without the status filter (archived agents must stay removable).
- The web test checks that `createTeamWithMembers` passes the Forbidden message on. It does not cover the lead-at-create path.
- The new-team toast shows "Not allowed: teams.add_agent" with no hint to ask the agent's owner.

## Ideas beyond the scope

- The new-team and add-agent pickers still list other people's agents. Filter them to the agents the person owns, or show who owns each.
- The team page shows the remove control only to the team owner, so an agent's owner who does not own the team can use the new remove right only through the API.
- Assumption, per the task: no invite flow. A team owner asks the agent's owner to add it. An invite would be a request in the owner's Needs you that adds the agent on approval.

## Steps for Dom

None. The controller's counts found 0 cross-owner agent memberships in production and staging.
