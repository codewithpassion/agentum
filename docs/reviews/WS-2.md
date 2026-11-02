# WS milestone gate review, WS-2

Commit 1a00ceb0, reviewed as `git diff 61d5a5c9..1a00ceb0` against WS.3, WS.4, and M1 and M2 in `docs/reviews/WS-1.md`.

## Verdict

Not clean: 1 must-fix, 12 nits.

M2 is fixed. M1 is fixed for the invitee flows I traced. The fix for WS.4's round 1 finding added the one must-fix: `/accept-invitation` accepts a pending invitation for whatever organisation the URL names, with no ticket, no confirmation and no `workspaces` row check. I reproduced it on the Clerk dev instance.

The reason it is must-fix: on the shared production instance, this route accepts and activates any pending invitation on the instance, including one to another app's organisation, because it never checks for a row. Harbourmaster should have no say over memberships in those organisations. I tested this on the dev instance with an organisation that has no row, not on production, and I did not check whether another app sees the changed active organisation.

The missing prompt alone would not justify this rating. The emailed link also accepts for a signed-in invitee with no prompt, so for an invitation sent from Harbourmaster a crafted link gives the inviting admin little beyond what the email already does. It grants no one access they weren't invited to either: the person must already hold a pending invitation for their own address, and an organisation with no row still gets a 401 from the app. The ticket-free accept is deliberate, because a signed-in invitee needs it, so the fix is a row check and a confirmation step, not its removal.

## Findings

| Severity | Finding | Area | Resolution |
|---|---|---|---|
| must-fix | A signed-in person opening `/accept-invitation?org=<id>` has any pending invitation to that organisation accepted, with no ticket, no prompt and no row check. Reproduced: a throwaway user became `org:admin` of an organisation with no row, the invitation went to `accepted`, and the organisation became active. `apps/web/src/integrations/clerk/accept-invitation.ts:84`, `apps/web/src/routes/accept-invitation.tsx:110` | Accept | Open, scope below |
| nit | A crafted link also switches a member's active workspace with no prompt, including to an organisation with no row, because `org` from the URL goes straight to `setActive`. `apps/web/src/routes/accept-invitation.tsx:117` | Accept | Open |
| nit | An organisation with no row ends on `/login`'s "Welcome back" with no explanation: `/desk` redirects there, not to `NoAccess`. `apps/web/src/routes/accept-invitation.tsx:118` | Accept | Open |
| nit | `useOrganizationList` uses Clerk's default page size of 10, so a member with more than 10 organisations can get "not for this account", and so can someone whose invitation is past the first page. WS.4's notes list the membership half. `apps/web/src/routes/accept-invitation.tsx:79` | Accept | Open |
| nit | The "not for the account you are signed in with" message also shows for a revoked or expired invitation. `apps/web/src/routes/accept-invitation.tsx:106` | Accept | Open |
| nit | `__clerk_status=complete` with a ticket shows `<SignUp>`, while the comment says a spent ticket gets sign-in, and no test covers it. I did not see Clerk send it: an accepted invitation's link redirected with `sign_in` and no ticket. `apps/web/src/integrations/clerk/accept-invitation.ts:38`, `:14` | Accept | Open |
| nit | `validateSearch` returns renamed keys, so the first load answers 307 and the URL carries the ticket twice: `__clerk_ticket=...&status=...&ticket=...`. `apps/web/src/integrations/clerk/accept-invitation.ts:54` | Accept | Open |
| nit | `isAdmin` comes from the session token, so a demoted admin can send invitations until the token refreshes. Same cause as the round 1 nit on create. I did not check whether Clerk refuses a non-admin `inviterUserId`. `packages/services/src/workspaces.ts:345` | Invite | Open |
| nit | The `already_invited` mapping never fires, as WS.4's notes record: Clerk re-issues silently, revokes the old link and takes the new role, and the dialog just says "sent". `apps/web/src/server/clerk-organizations.ts:45` | Invite | Open |
| nit | No cap or rate limit on invitations: any workspace admin can make the shared instance email any address. `packages/services/src/workspaces.ts:338` | Invite | Open |
| nit | Docs describe the signed-in path as only `setActive` and leave out accepting the pending invitation. CLAUDE.md also says a pending `choose-organization` session is production only, but a user with no active organisation got one on the dev instance. `docs/ux-review/rail/spec.md:161`, `CLAUDE.md:194`, `CLAUDE.md:236` | Docs | Open |
| nit | WS.3's check asks for a scratch copy following the skill, and the notes say none was made; they tested the same handler in the repo. The skill also doesn't say `composeServices` must run before `/api/dev-login`. `.claude/skills/add-clerk/SKILL.md:145`, `docs/reviews/tasks/WS.3.md` | Dev login, skills | Open |
| nit | The production path stays unproven, as WS.4's notes say. If a session is pending when the form returns, Clerk goes to `/choose-organization`, whose `redirectUrlComplete="/"` drops `org`. On the dev instance a person with several organisations, opening the ticket link signed out, did land in the inviting organisation with an active session. `apps/web/src/routes/choose-organization.tsx:13` | Production | Dom's post-deploy check |

## Task-ready scope and check

### M1: accepting an invitation needs the person's say-so and a workspace row

Scope:
- `/accept-invitation`, signed in, when `activationPlan` returns `accept`: show the organisation's name from `publicOrganizationData` and a `Join` button. Call `accept()` only on that click. This applies with or without `__clerk_ticket`, because the route can't verify a ticket's value on a signed-in session.
- Before offering `Join` or calling `setActive`, check on the server that the organisation has a `workspaces` row. Add a `signedInProcedure` query to `workspaces-router.ts`, with the rule in `packages/services/src/workspaces.ts`, that takes an org id and returns only whether a row exists. No row means no accept and no `setActive`, and the page shows the existing error. The query reveals only whether a row exists, and only to a signed-in user.
- Keep the signed-out flows as they are: the forms spend a real ticket for the invited address.
- Update `docs/ux-review/rail/spec.md` and `CLAUDE.md` Auth, which also closes the docs nit on the accept step.

Check:
- Unit: the plan accepts only after confirmation, and an organisation with no row gets neither accept nor activate. Service or router test: the row query answers for an organisation with and without a row, and refuses a signed-out caller.
- Browser, Clerk dev instance, throwaway `+clerk_test` users, and removed afterwards. Signed in with a pending invitation to an organisation with no row, opening `/accept-invitation?org=<id>`: the invitation stays `pending`, there is no membership, and the active organisation is unchanged.
- Same, with a row: nothing changes until `Join` is clicked, then the invitation is `accepted` and the person lands on `/desk` in that workspace.
- Signed out, with the email link: a brand-new user and an existing user still land on `/desk` in the inviting workspace.
- `bun run check && bun run test && bun run build`, and the grep of `apps/web/dist/client` for `drizzle` finds nothing.

## Focus areas

`workspaces.inviteFromSession`: clean. The only caller is `workspaces.invite`, on `workspaceProcedure`. The service refuses anything but `kind: user`, `via: session`, `isAdmin: true`, and tests cover each non-session principal. The input is a strict object of email and role, so no organisation can come from the client. The organisation is read from the principal's workspace row. No MCP tool or other route calls it. `csrf()` covers `/api/trpc`.

`redirectUrl`: clean. It is built only from `PUBLIC_BASE_URL`, a fixed var in `wrangler.jsonc`, never from the request. `new URL` takes a constant path, and `org` goes in through `searchParams`. An empty value, as on previews, refuses the send. Only the client-side links afterwards use the URL's `org`, and they are relative and encoded.

`/accept-invitation`:
- A ticket from the URL is never trusted by app code. Only Clerk's forms read one, and the signed-in path ignores it.
- It can't join an organisation the person wasn't invited to: the invitation list is the signed-in user's own, and `none` gives the error.
- An organisation with no row gets no app access: `/api/trpc/me` answered 401 and `/desk` went to `/login`. It does get accepted and activated in Clerk, which is M1.

Open redirects:
- `/accept-invitation`'s return path is relative and encoded, and the forms use `forceRedirectUrl`.
- Signed in, `redirect_url=https://evil.example/x` stayed on this origin on `/sign-up`, `/login` and `/accept-invitation`, and `//evil.example/x` stayed on this origin on `/sign-up`.
- Not tested: the end of a signed-out `/sign-up` with `redirect_url`, which has no `forceRedirectUrl` and depends on Clerk's default allowed origins. That route is unchanged in this diff, and Clerk's bot check blocks headless Chrome on the form.

M2: the snippet matches the `/api/dev-login` handler in `server.ts` by reading. The WS.3 wording grep and doc corrections are in the diff. I did not repeat the clean `.wrangler` login.

## Checks run

- `bun run check`, `bun run test`, `bun run build`: pass, 0 failures. `apps/web/.env` copied from `.env.example`.
- Grep of `apps/web/dist/client` for `drizzle`: 0 files.
- Browser and Clerk Backend API on the dev instance, with `sk_test_` only and a local `vite dev`: the must-fix, the 401 and `/desk` results, the `redirect_url` probes, the ticket link for a person with several organisations, and the ticket link's status before and after accepting.
- All test data removed: 4 organisations and 2 users deleted, each answering 200. Dev server stopped by PID, copied env files removed, worktree clean and detached at 1a00ceb0.
- Not run: `.env.local` dev user flows beyond the above, production, and the A2A interop scripts (this diff doesn't touch A2A).
- During the run the browser session started out signed in as the dev user, so my first crafted-link result was invalid and I discarded it. I signed that browser session out, then repeated the test as the throwaway user.
