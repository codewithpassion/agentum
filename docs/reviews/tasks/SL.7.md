# SL.7 review: a guest author kind

## Choice
A nullable `guest_name` column on `inbox_posts` (migration 0061), not a new `guest` author kind. A new kind would widen `InboxAuthorKind`, which feeds event actors, the wake logic, the desk and the directory lookups. The column touches only the posts a guest writes. A guest is a post whose `guest_name` is set. The `slack:` author id stays, as the stable guest id.

## Verdicts
- Round 1 (72c0776c): must-fix. Moving the name out of the text hid it from agents: the wake context (`earlierPosts`), the MCP `PostInfo` ports and the dream's `collectRoomPosts`.
- Round 2 (b1ad8321, fix commit only): clean. The wake line carries `slackGuest`, `inbox_read` shows "(Slack guest NAME)", the dream credits "NAME (Slack guest)".
- Browser proof: skipped by Dom's rule. Browser steps move to one pass at the end of v4. A verifier did see the room at both sizes before the rule (guest name, Slack guest tag, no prefix, no overflow), but its report is not kept.

## Migration
0061 adds the column and splits the `<Name> (Slack guest): ` prefix of existing guest posts (user posts with a `slack:` author id) at the first separator. A `slack:` post with no prefix gets the name "Someone". Member posts that quote the phrase are untouched. Tested in `packages/db/src/guest-name-migration.test.ts`.

## Nits left
- A discussion round's "Latest post:" line (`teams/discussions.ts:470`) shows text only, so a guest's name is missing there. It never named any author.
- No direct tests for the `inbox_read` guest label or the dream's guest author name.
- A topic a guest opens still stores the guest id in `created_by`.
- Nothing ties `guestName` to a `slack:` author id. `room-out` skips sending on `guestName` alone.

## Beyond scope
- Pass the guest name in the discussion "Latest post:" line.
- Show the guest name in the topic list's last-author line, if one is added.

## Dom
- Migration 0061 needs `wrangler d1 migrations apply DB --remote` on staging and production after merge.
