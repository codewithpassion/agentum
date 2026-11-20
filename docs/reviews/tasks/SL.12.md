# SL.12 review

Round 1 at 02e26ace: must-fix. The owner-or-admin guard sat inside `recordAlwaysAllow`, which the mail release calls with a principal that has no `isAdmin`. An admin who does not own the agent closed the request, then the release threw and the mail stayed held, with no failure shown.

Round 2 at 905b6a4b: clean. The guard now runs in `answer` only, before the request closes. `recordAlwaysAllow` stays unchecked, with a doc comment saying why. A mail test covers an admin who does not own the agent always allowing a multi-recipient email.

## Nits left

- `recordAlwaysAllow` is public on the requests service and checks nothing. Today's two callers (`answer` and the mail release) are safe. Renaming it `unchecked...` or passing it only to the mail service would make a future bypass harder.
- The comment in the new mail test is a bit hard to read.
- The refusal uses error code `invalid` (400) with reason `always_allow_owner_only`. There is no `forbidden` service error code. Clients read the reason.

## Ideas beyond the scope

- Slack cannot hide a button per viewer, so a non-owner still sees Always allow. A card variant for the owner only would need per-viewer cards.
- An admin who does not own the agent is refused in Slack, by decision. Linking Slack identity to org role would lift that.

## Steps for Dom

None.
