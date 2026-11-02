---
id: WS.5
title: "Accepting an invitation needs the person's say-so and a workspace row"
milestone: WS
size: S
status: done
depends_on: [WS.4]
branch: task/WS.5-accept-needs-row-and-consent
lane: web
executor: claude
---

From the milestone gate, `docs/reviews/WS-2.md`, its one must-fix. WS.4 is on staging and not on production. This task goes first, because production's Clerk instance is shared with other apps.

A signed-in person opening `/accept-invitation?org=<id>` has any pending invitation to that organisation accepted, with no ticket, no prompt and no `workspaces` row check. The organisation then becomes active. The person must already hold a pending invitation for their own address, and an organisation with no row still gets a 401 from the app. But Harbourmaster should have no say over memberships in another app's organisation, and a crafted link should not join anyone to anything without a click.

## Decisions
- The ticket-free accept stays, because a signed-in invitee needs it. The fix is a confirmation step and a row check.
- The signed-out flows stay as they are: Clerk's forms spend a real ticket for the invited address.

## Scope
- `/accept-invitation`, signed in, when `activationPlan` returns `accept`: show the organisation's name from `publicOrganizationData` and a `Join` button. Call `accept()` only on that click, with or without `__clerk_ticket`, because the route can't verify a ticket's value on a signed-in session.
- Before offering `Join` or calling `setActive`, ask the server whether the organisation has a `workspaces` row. Add a `signedInProcedure` query to `apps/web/src/server/trpc/workspaces-router.ts`, with the rule in `packages/services/src/workspaces.ts`. It takes an org id and returns only whether a row exists. No row means no accept and no `setActive`, and the page shows the existing error. This also stops a crafted link switching a member to an organisation with no row.
- `useOrganizationList` in `accept-invitation.tsx` asks for `{ infinite: true, pageSize: 100 }`, like the other call sites, so a person with more than 10 organisations isn't told the invitation isn't theirs.
- Update `docs/ux-review/rail/spec.md` and `CLAUDE.md` Auth, which describe the signed-in path as only `setActive`. Also correct `CLAUDE.md` where it says a pending `choose-organization` session is production only: a user with no active organisation got one on the dev instance.

## Check
- Unit: the plan accepts only after confirmation, and an organisation with no row gets neither accept nor activate. Service or router test: the row query answers for an organisation with and without a row, and refuses a signed-out caller.
- Browser, Clerk dev instance only, with throwaway `+clerk_test` users removed afterwards. Signed in with a pending invitation to an organisation with no row, opening `/accept-invitation?org=<id>`: the invitation stays `pending`, there is no membership, and the active organisation is unchanged.
- Same, with a row: nothing changes until `Join` is clicked, then the invitation is `accepted` and the person lands on `/desk` in that workspace.
- Signed out, with the email link: a brand-new user and an existing user still land on `/desk` in the inviting workspace. Clerk's bot check blocks headless Chrome on the form, so use a headed Chrome on a virtual display.
- Never use the production Clerk key.
- `bun run check && bun run test && bun run build`, and the grep of `apps/web/dist/client` for `drizzle` finds nothing.

## Log
- 2026-11-02: created from the WS gate, round 2, and dispatched.
- 2026-11-02: review clean after 0 fix rounds. Merged and pushed.
- 2026-11-02: deployed to staging at 0348b3db (Worker version 3bb522f1). A real emailed invitation to a brand-new address, sent from Invite people, signed up from the link while signed out and landed on /desk in the inviting workspace. Test user deleted. The signed-out existing-user path was tested in WS.4 and not repeated here.
