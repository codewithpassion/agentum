# WS.5 review

Accepting an invitation needs the person's say-so and a workspace row.

## Verdicts

Round 0, commit ecc06b3: clean. Seven nits, no must-fix. No fix rounds.

## Browser check (Clerk dev instance, throwaway `+clerk_test` user and organisations, removed afterwards)

- Signed in, pending invitation to an organisation with no `workspaces` row, opening `/accept-invitation?org=<id>`: the page shows "This invitation is not for the account you are signed in with." and no Join button. The invitation stays `pending`, there is no membership, and the active organisation did not change.
- Same, with a row: the page shows "Join WS5 Row?" and the invitation stays `pending` until `Join` is clicked. After the click it is `accepted`, the person is a member, and the browser lands on `/desk` with "WS5 Row" active.
- A member of an organisation with a row opening the link goes straight to `/desk` with that organisation active.
- Not run: the signed-out email-link flows (brand-new user and existing user). Clerk sends no email to `+clerk_test` addresses and the Backend API does not return the ticket, so the link cannot be built without a real inbox. The code path after the form is the member path above, with `hasRow` true. See Dom's steps.

## Nits

Fixed after the review: the route's top comment now mentions the row check and `Join`, and the spec wording for who sees `Join` is corrected.

Left:
- The message for a member of an organisation with no row says "not for the account you are signed in with". The task asked to reuse the existing error.
- `plan` is a new object each render, so the effect runs each render. The `started` ref makes it harmless.
- The `Join` screen has no decline button.
- Only `activationPlan` is unit tested. No component test covers that `accept()` waits for the click.

## Ideas beyond the scope

A signed-in person with no active organisation gets a pending session, and `PendingSessionGate` sends them to `/choose-organization`, Clerk's own picker. That picker lists pending invitations with `Join` buttons and has no `workspaces` row check, so it can accept an invitation to another app's organisation. `PendingSessionGate` also activates a user's only organisation with no row check. This leaves part of "Harbourmaster has no say over memberships in another app's organisation" open. Worth a follow-up task: replace Clerk's picker with a page built on `workspaces.hasWorkspace`.

## Steps for Dom

Check the signed-out email link on staging once this is merged: invite a brand-new address and an existing user from `Invite people`, open each email link in a headed browser, and confirm both land on `/desk` in the inviting workspace.
