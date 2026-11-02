# WS.6 review: our own organisation picker, and no activation without a workspace row

## What changed

`/choose-organization` no longer renders Clerk's `TaskChooseOrganization`. It lists `workspaces.mine`, the person's organisations that have a `workspaces` row, and choosing one calls `setActive` then does a full load to the `redirect` query value (a same-origin path) or `/desk`. It cannot create an organisation or accept an invitation. A person with no workspace sees the `NoAccess` words and `Sign out`. The list, its empty state and the sign-out button are one component, `components/rail/workspace-choice-list.tsx`, shared with the landing page's `NoAccess`. `useSwitchWorkspace` takes the target.

`PendingSessionGate` asks `workspaces.mine` and auto-activates only when the person has exactly one organisation with a row (`soleWorkspaceOrgId`). Otherwise it goes to the picker, carrying the page the person was on as `redirect`. It does nothing on `/accept-invitation`, which activates the inviting organisation itself, so an invitee with a pending session ends on `/desk` in that organisation after clicking `Join`. The `org` never has to pass through the picker.

## What can answer for a pending session

The app treats a pending session as signed out, and `getAuth`/`auth()` return a null user for it unless called with `treatPendingAsSignedOut: false`. So `workspaces.mine` and `workspaces.hasWorkspace` (both `signedInProcedure`) answered 401 to a pending session. `ctx.userId` now comes from the pending-aware call. `ctx.principal` still comes only from the default call, so `workspaceProcedure` still refuses a pending session. `mine` reads the user's memberships from the Clerk backend by that user id, so no org id comes from the client. The add-clerk copy of `context.ts` has the same change.

## Verdicts

Round 1 at 63d1afd1: must-fix, one finding. `safeRedirectPath` let `/<tab>/evil.example` through, which a browser parses as `//evil.example`, and the gate followed it with no click. Fixed in 80d28bec by rejecting control characters.

Round 2 at 80d28bec: clean.

## Browser check (Clerk dev instance, throwaway `+clerk_test` users, all deleted afterwards)

The dev instance activates an organisation by itself for a user who signs in with memberships, so a pending session there only happens for a user with no membership. Each case was made by signing in with none, then adding memberships through the Clerk backend and reloading.

- One organisation with a row and one without: the gate activated the one with a row, the other never became active.
- Two with rows and one without: the picker listed the two, and the one without a row was absent. Choosing one landed on its page, with `redirect=/library` honoured.
- No membership, pending invitation to an organisation without a row: the picker showed the `NoAccess` words and no `Join`. The invitation stayed `pending` and there was no membership.
- Pending invitee with an invitation to an organisation with a row, on `/accept-invitation?org=...`: the page asked `Join <name>?`, and after the click the session was active in that organisation on `/desk`.
- Agent Task login on the dev instance still signs in and lands on an app page.

## Not verified

The production instance leaves an Agent Task session pending even with memberships, which the dev instance does not reproduce. As with X.5, that path rests on the gate's logic and the checks above. Clerk's own redirect to the task URL carries no original page, so there the person lands on `/desk` after the pick, or on the page the gate saw. Staging is the real test.

## Nits left

- `ctx.userId` now exists for a session pending on any Clerk task (`reset-password`, `setup-mfa`), not only `choose-organization`. It reaches only `workspaces.mine` and `hasWorkspace`.
- `build-context.test.ts` does not test that `context.ts` takes the two ids from the right calls.
- Opening `/choose-organization` with a workspace already active says "This session has no Harbourmaster workspace" and marks no current one.
- The picker reads the first 100 Clerk memberships for names. Past that, a workspace shows its org id.
- The redirect test has no DEL case.

## Ideas beyond the scope

- Make the unauthorised redirect in `routes/_app.tsx` carry the page asked for, so a pending session that opens a protected page gets back to it.
- Carry `org` through the picker if a future flow needs it.

## Steps for Dom

On staging, with an Agent Task sign-in for a user with one organisation that has a row and one that does not, confirm the session lands active in the one with a row. Production needs the same check after deploy.
