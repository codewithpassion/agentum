# WS.4 review

Task: invite people from Harbourmaster, so a new user lands back in the workspace.

## Verdicts

Round 1, commit 5edb6fad: must-fix. A person already signed in when they open the email link went straight to `setActive` and never spent the ticket, so for an existing Harbourmaster user the invitation stayed pending and the switch failed.

Round 2, commit 9e35cb5c (fix commit only): clean. `/accept-invitation` now accepts the pending invitation first (`activationPlan` in `integrations/clerk/accept-invitation.ts`), then makes the organisation active. Checked in headed Chrome on the Clerk dev instance: the invitation went to `accepted` and the user landed on `/desk` in the inviting workspace.

## What was checked in a browser (Clerk dev instance, `+clerk_test` addresses)

- A member sees no `Invite people`. An admin sees it.
- An admin sent invitations as Member and as Admin. Both appeared in Clerk with the right role and a redirect URL on the dev server.
- A brand-new user opened the link, got `<SignUp>` with the ticket, set a password and landed on `/desk` in Dev Workspace.
- An existing user who belongs to another organisation (with its own workspace row) opened the link signed out, signed in with the ticket, and landed in Dev Workspace. The same user, signed in, opened a second invitation and also landed in Dev Workspace.
- Inviting an existing member shows "... is already a member of this workspace."
- Clerk's profile (`Manage members`) opened with its invite button hidden, through `appearance.elements.membersPageInviteButton`. Clerk allowed it.

All test users, organisations and invitations were removed from the dev instance afterwards.

## Nits left

- `accept-invitation.tsx`: `useOrganizationList` uses Clerk's default page size (10). A person in more than 10 organisations who is already a member of the inviting one could get the "not for this account" message. Other call sites use `{ infinite: true, pageSize: 100 }`.
- The "not for the account you are signed in with" message also shows for a revoked or expired invitation.
- `activationPlan` could return the invitation itself, which would drop the second lookup by id.
- No test pins the case where an org is both a membership and a pending invitation (it activates).
- The `already_invited` mapping (Clerk code `duplicate_record`) never fires on the dev instance. Clerk's Backend API replaces a pending invitation for the same address with a new one and revokes the old link. The mapping stays because the task asked for it, and costs nothing. The first send is re-issued silently.

## Beyond the scope

- A pending-invitations list and revoke inside the dialog. Today revoking lives in Clerk's profile.
- Several addresses in one send (Clerk has a bulk endpoint).
- A "this link is for another address" message when a signed-in person's email differs from the invited one.

## Steps for Dom

- Production is unproven. The Clerk production instance leaves a new session `pending` with the `choose-organization` task, and the forms may send the person to `/choose-organization` instead of back to `/accept-invitation`. Send one real invitation to a spare address after the deploy and check it lands on `/desk`. If it lands on the picker, the picker's `redirectUrlComplete` needs the organisation id.
- The dev instance has sign-up mode `public`, so "an uninvited sign-up is refused under restricted sign-up" could not run. Turn on restricted sign-up in the production dashboard if it is not on, and check an uninvited sign-up there.
- Previews set `PUBLIC_BASE_URL` to an empty string, so `Invite people` there answers "Invitations are not set up on this deployment." The menu item still shows. Staging and production have a base URL.
- Clerk's bot check blocks headless Chrome on the embedded form. A headed Chrome on a virtual display passes it, as CLAUDE.md now says.
