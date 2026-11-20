# FR.2 review: Team starter

## Verdicts

- Round 0, 1136ba1b (Codex implementation): must-fix. Two slug clashes (an existing agent slug, an existing or repeated team or member slug) surfaced as raw unique-constraint errors instead of `conflict`.
- Round 1, 2495c517: must-fix. The fix added a pre-check and a unique-violation mapping, but the rollback test no longer reached the atomic write, so the mapping was untested.
- Round 2, f424d3fc: clean. The test is split in two, one for the pre-check and one for a slug taken during the write.

## Nits left

- `writeUnique` and the slug messages repeat `uniqueWrite` (teams.ts) and `slugTaken` (agents.ts), which are not exported.
- Only `harbourmaster/commit_skill` gets the ask rule. `revert_skill` is already only a proposal from a run.
- Skill and connector assignments are inserted directly, so they skip the same-name check and the `skill.assigned` event.
- CRM tidy shares the Lead research connectors, since the repo has no CRM connector template.
- The lead's `handsTo` stays empty and is not pointed at the specialists.
- Template notes (suggested job, ask level, remember items) are not carried into the team review.
- Starter agents get no reserved email address.
- The "during the write" test checks only the `conflict` code and the pre-check path, and the rollback check covers only agents and teams.
- `slugSchema.parse(slugify(member.name))` runs twice per member.

## Ideas beyond scope

- Dedicated lead, outreach and CRM templates in FR.1's template set.
- Let the lead's `handsTo` name its specialists at team creation.

## Steps for Dom

None.
