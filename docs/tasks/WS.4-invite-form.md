---
id: WS.4
title: "Invite people from Harbourmaster, so a new user lands back in the workspace"
milestone: WS
size: M
status: done
depends_on: [WS.2]
branch: task/WS.4-invite-form
lane: services
executor: claude
---

From the milestone gate, `docs/reviews/WS-1.md`, must-fix M1, and Dom's decision of 2 November 2026.

An invitation sent from Clerk's organisation profile carries no redirect URL, so a brand-new user goes to Clerk's hosted sign-up and then to the instance's home URL. Production's Clerk instance is shared with other apps, so that home URL can't be Harbourmaster's. Dom chose an invite form in the app over changing it. This reverses WS.2's "no invite screens" decision for sending invitations only.

## Decisions
- The workspace menu gets `Invite people`, shown only to an `org:admin` and enforced on the server. It opens a dialog with an email address and a role, `Member` by default or `Admin`.
- The server sends the invitation with Clerk's Backend API, with `inviterUserId` set to the caller and a `redirectUrl` on this deployment's `PUBLIC_BASE_URL`.
- `Manage members` stays Clerk's profile, for the member list, roles, pending invitations and revoking. Hide its own invite button if Clerk's `appearance` elements allow it, so nobody sends the misrouted kind by habit. If Clerk doesn't allow it, say so in the review notes and leave it.
- No Clerk dashboard change on the production instance.

## Scope
- `packages/services/src/workspaces.ts`: `inviteFromSession(principal, { email, role })`. It refuses anyone but a browser-session `org:admin`, the same as `createFromSession`, validates the email, and takes the organisation from the principal, never from the client. The Clerk call goes through the injected port, and the service never reads `env`. Map "already a member" and "already invited" to clear messages.
- `apps/web/src/server/clerk-organizations.ts`, `server/compose.ts`, `trpc/workspaces-router.ts`: the port and a thin mutation. No MCP tool.
- `apps/web/src/components/rail/`: the menu item and dialog, with its logic in a tested helper.
- The landing route. The WS.2 run found a `redirect_url` on `/` lands on the signed-out page with `__clerk_ticket` and shows no form, and `/sign-up` was never tried. `/sign-up` renders `<SignUp routing="hash" />`. Find out from Clerk's current docs, then by testing, how a ticket is consumed there, and handle both `__clerk_status` values: a new user signs up, and an existing user signs in. Make the route that works the redirect target.
- After accepting, the person lands on `/desk` in the inviting workspace, even if they belong to other organisations. Check this against `PendingSessionGate` and `/choose-organization`.
- `docs/ux-review/rail/spec.md` and `CLAUDE.md` Auth: describe it.

## Check
- Service tests: an admin invites, and the port gets the principal's organisation, the caller and the right redirect URL. A non-admin and each non-session principal are refused. A bad email is refused. The two Clerk conflicts give their messages.
- Browser, on the Clerk dev instance only (`apps/web/.env.local`): a non-admin sees no `Invite people`. An admin sends an invitation to a `+clerk_test` address, a brand-new user accepts it and lands on `/desk` in that workspace, and an existing user in another organisation does the same. An uninvited sign-up under restricted sign-up is refused, if the dev instance has it on. Use Clerk's test email addresses and never send to a real inbox.
- Clerk's bot protection stopped headless Chrome at hosted sign-up in WS.2. If it also stops the embedded form, try a headed browser. If that fails too, test the ticket handling as far as it goes and report exactly what is unproven, in the `Dom:` line.
- Never use the production Clerk key.
- `bun run check && bun run test && bun run build`, and the grep of `apps/web/dist/client` for `drizzle` finds nothing.

## Log
- 2026-11-02: created from the WS gate and Dom's decision, and dispatched.
- 2026-11-02: review clean after 1 fix round. Merged and pushed. Tested on the dev instance with Clerk test addresses. Production is unproven, because its sessions stay pending with the choose-organization task.
- 2026-11-02: deployed to staging at b5bb5f26 (Worker version a89b12be). The menu item and dialog checked there. Gate round 2 found a must-fix in /accept-invitation, so WS.5 goes before production.
- 2026-11-02: production deployed at 7c2ed6cf (Worker version bc42a9d2, was 585be69b), with Dom's go-ahead. The first attempt stopped on a Cloudflare authentication error during the release upload, before the Worker deploy, and the retry passed. Invite people shows on production. A real invitation on production is still to be tested.
