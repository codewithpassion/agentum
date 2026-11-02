---
id: WS.6
title: "Our own organisation picker, and no activation without a workspace row"
milestone: WS
size: S
status: done
depends_on: [WS.5]
branch: task/WS.6-replace-org-picker
lane: web
executor: claude
---

From `docs/reviews/tasks/WS.5.md` and Dom's decision of 2 November 2026.

A signed-in person with no active organisation gets a pending session, and `PendingSessionGate` sends them to `/choose-organization`. That route renders Clerk's `TaskChooseOrganization`, which lists pending invitations with `Join` buttons and can create an organisation, with no `workspaces` row check. `PendingSessionGate` also activates a user's only organisation with no row check. Production's Clerk instance is shared with other apps, so Harbourmaster must not change memberships in, or activate, an organisation that has no row.

## Decisions
- `/choose-organization` becomes our own list, built from `workspaces.mine`: the organisations this person belongs to that have a row. Choosing one activates it with `setActive`, then does a full load to the page they asked for, or `/desk`. It offers no way to create an organisation and lists no invitations. Invitations are accepted on `/accept-invitation`.
- A person with no workspace sees the same words as `NoAccess`, and `Sign out`.
- A pending session can only finish by activating an organisation the app admits. Check how the page behaves when the session is `pending`, because the app treats that as signed out and `signedInProcedure` may not see it. If `workspaces.mine` can't answer for a pending session, find what can, and say so in the review notes. Never trust a list of org ids from the client.

## Scope
- `apps/web/src/routes/choose-organization.tsx`: the list, sharing what it can with the workspace menu and `NoAccess`. Remove `TaskChooseOrganization`.
- `apps/web/src/integrations/clerk/pending-session-gate.tsx` and `sole-organization.ts`: auto-activate only when the person has exactly one organisation with a row, counting only those. Otherwise go to the picker.
- `/accept-invitation`: an invitee who arrives with a pending session after the form, which is production's behaviour, must end on `/desk` in the inviting organisation. Keep the `org` through the picker if it has to pass through it. Keep WS.5's rule that nothing is accepted without a click and a row.
- `CLAUDE.md` (Auth and Agent Task login), `docs/ux-review/rail/spec.md` and the `add-clerk` skill and templates, if they carry this route.

## Check
- Unit: the sole-organisation helper counts only organisations with a row, and a user with one row and one other organisation auto-activates that row. The picker's logic is tested.
- Browser, Clerk dev instance only, with throwaway `+clerk_test` users removed afterwards. A user with no active organisation who belongs to one organisation with a row and one without lands on that workspace's `/desk`. A user with two rows sees both and can choose. The organisation with no row never appears and never becomes active. A user with a pending invitation to an organisation with no row sees no `Join`, and the invitation stays `pending`.
- The Agent Task login still lands on the page asked for, as `CLAUDE.md` describes.
- Never use the production Clerk key.
- `bun run check && bun run test && bun run build`, and the grep of `apps/web/dist/client` for `drizzle` finds nothing.

## Log
- 2026-11-02: created from Dom's decision, and dispatched.
- 2026-11-02: review clean after 1 fix round. Merged and pushed.
