# SL.13 review

## Rounds

- Round 1 (4b716924): must-fix. A Slack Connect user with a hidden email, or a failed `users.info` call, got the "make your email visible" reply, because the email check ran before the team check. Fixed in 51cc0713 by checking the team first. The e2e doc line about a "Slack link on the team page" was also removed, because no page shows it.
- Round 2 (51cc0713): clean.

## Nits left

- No test covers a failed `users.info` call in the room path.
- `wasTold` reads before the post write, so two close messages from one guest can both get the reply. The event rides in the winning post's write, so a later message is safe.
- Every copy of every message from an unmatched guest calls Slack `users.info` and the Clerk directory. Nothing remembers a no-match.
- `wasTold` filters with `json_extract` over the workspace's `slack.unlinked_sender` events, a scan within the index range.
- A person whose email matches but who is not in the team gets the link written and posts as a guest with no reply, and no test covers it.

## Ideas beyond the scope

- Remember a no-match, or cache the Slack lookup, so a chatty guest costs one lookup.
- Tell a matched person who is not in the team that they need to be added to it.
- The own-team test compares `users.info` `team_id` with the app's team id. An Enterprise Grid member of a sibling workspace has a different `team_id`, and would be treated as external. Check this when a Grid customer appears.
- The DM path (`meetUnlinkedSender`) does not skip Slack Connect users. Apply `ownTeamOnly` there too if needed.

## Steps for Dom

None. The e2e steps 3 and 7 in `docs/reviews/SL-e2e.md` need a staging run with the Slack workspace and the usual `users:read.email` scope.
