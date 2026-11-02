# WS milestone gate review, WS-1

Commit 61d5a5c9, reviewed as `git diff ws-start..61d5a5c9` against WS.1 and WS.2. RL.10 was read only where WS.2 touches it.

## Verdict

Not clean: 2 must-fix, 18 nits.

I found no access hole. No path I traced admits an organisation with no `workspaces` row, and none takes an org id from the client. Both must-fix items are about getting in as intended: the invitation flow and a fresh copy's dev login.

## Findings

| Severity | Finding | Area | Resolution |
|---|---|---|---|
| must-fix | The WS.2 check "accept the invitation as a brand-new user and arrive in the workspace" never passed. The review's proposed fix, setting the home URL in the Clerk dashboard, is an instance-wide setting on a production instance shared with other apps. `apps/web/src/components/rail/workspace-menu.tsx:95`, `docs/reviews/tasks/WS.2.md` (Browser run, Steps for Dom) | Invitations | Open, scope M1 below |
| must-fix | The add-clerk skill's `/api/dev-login` snippet has no row creation, while the text says the dev login makes the row. A fresh copy's one-click login lands on NoAccess on a clean `.wrangler`. `.claude/skills/add-clerk/SKILL.md:112`, `.claude/skills/add-clerk/SKILL.md:342` | Dev login, skills | Open, scope M2 below |
| nit | Nothing can retire a workspace now. The list was the kill switch; a row can't be deleted while foreign keys hold, and D1 can't switch them off. Machine, trigger, run and routine principals check only the row, so they also keep working after the Clerk org is deleted. `packages/services/src/workspaces.ts:580` | Principals | Dom to decide if a disable flag is wanted |
| nit | Organisations not made by `createFromSession`, including those from `add-workspace`, keep admin delete on, and Manage members now offers their admins a delete that strands the data. `apps/web/scripts/add-workspace.ts:58`, `apps/web/src/components/rail/workspace-menu.tsx:95` | Create | Open |
| nit | No cap or rate limit on creation: any admin of any workspace can mint unlimited organisations on the shared instance. `packages/services/src/workspaces.ts:270` | Create | Open |
| nit | `isAdmin` comes from the session token's role claim, so a demoted admin can still create a workspace until the token refreshes. `packages/services/src/workspaces.ts:256` | Create | Open |
| nit | A failed rollback delete is swallowed with no log, which leaves an invisible organisation with no row. It gets no access. `packages/services/src/workspaces.ts:300`, `apps/web/src/server/clerk-organizations.ts:47` | Create, partial failure | Open |
| nit | If the row insert commits and the read-back in `create` throws, the rollback deletes the organisation and leaves a row pointing at nothing. It gets no access. `packages/services/src/workspaces.ts:209`, `packages/services/src/workspaces.ts:300` | Create, partial failure | Open |
| nit | The dialog's retry guard only holds after a response arrives. A lost response followed by a retry makes a second workspace, closing mid-request clears the guard, and the name stays editable when a retry ignores it. `apps/web/src/components/rail/new-workspace-dialog.tsx:53`, `apps/web/src/components/rail/new-workspace-dialog.tsx:78` | Create, UI | Open |
| nit | `mine` and `firstForOrgs` bind one parameter per organisation, and D1 allows 100 per query, so a person in about 100 organisations gets a 500 on the menu and on NoAccess. `packages/services/src/workspaces.ts:324`, `packages/services/src/workspaces.ts:230` | Read | Open |
| nit | `clerkUserOrgIds` and the client's name lookup read only the first 100 memberships. Past that, an OAuth home workspace can be missed and a menu row shows an org id. `apps/web/src/server/mcp/clerk-membership.ts:42`, `apps/web/src/components/rail/workspace-menu.tsx:66` | Read | Open |
| nit | A failed `workspaces.mine` is ignored, so a Clerk outage tells a member to ask an admin for an invite and empties the menu. `apps/web/src/routes/index.tsx:91`, `apps/web/src/routes/index.tsx:127` | NoAccess | Open |
| nit | The rail polls `workspaces.mine`, one uncached Clerk Backend call per refresh and tab. `apps/web/src/components/rail/workspace-menu.tsx:68` | Read | Open |
| nit | A preview gets an empty D1 and no row, dev login is off, and `add-workspace` can't target it, so `agent-login --env preview` ends on NoAccess. Previews are not set up today: no preview workflow runs or repo secrets are listed. `apps/web/scripts/preview.ts:205`, `apps/web/scripts/add-workspace-helpers.ts:75` | Previews | Open, needed before `setup-previews` runs |
| nit | Dev login takes the dev user's first membership and gives it a row. After the dev user creates a workspace, or joins another org on the dev instance, login may land there instead. Dev builds only: the branch is absent from the built Worker. `apps/web/src/server.ts:171` | Dev login | Open |
| nit | A first-seen OAuth client always lands in the person's oldest workspace, and `client_id` is unique across workspaces, so people in several workspaces can't choose. WS.2 makes that common. `apps/web/src/server/mcp/oauth-auth.ts:57` | OAuth | Open |
| nit | `docs/HANDOVER.md:8`, rewritten in this diff, says staging runs on the shared production instance, and `docs/reviews/tasks/WS.1.md` (For Dom) says the same. Staging runs on the dev instance: LR.4 moved it, `.env.staging` holds a `faithful-falcon-1887.clerk.accounts.dev` key, and `resolveSecretKey` and CLAUDE.md agree. | Docs | Open |
| nit | Old wording remains: "This organisation can't use Harbourmaster" at `README.md:123`, `.claude/skills/add-clerk/SKILL.md:363`, `.claude/skills/setup-cloudflare/SKILL.md:97`; "allowed organisation" at `CLAUDE.md:233`, `apps/web/src/routes/index.tsx:17`, `apps/web/src/server/trpc/triggers-router.test.ts:150`. WS.1 asked for the index.tsx comment to be fixed. | Docs | Open |
| nit | WS.2 asked for a report of what `TaskChooseOrganization` does in the browser. The notes say it was not exercised, so its dead-end question is unanswered. `apps/web/src/routes/choose-organization.tsx` | Scope | Open |
| nit | `freshMember`, the live-artifact room's fresh check, has no unit test. Its row check is `sessionPrincipal`, which is tested. `apps/web/src/server/live-artifacts/auth.ts:21` | Tests | Open |

## Task-ready scope and check

### M1: invitations reach the workspace

The WS.2 notes record that an invitation sent from Clerk's profile has no redirect URL and goes to the hosted sign-up. With `redirect_url`, it lands on `/` with `__clerk_ticket` on the signed-out page, which shows no sign-up form. This is an unmet check and a design gap in the production path. It is not a bug I reproduced.

Scope:
- Check on staging, with a real inbox and a person's browser, where a brand-new invitee lands from a profile-sent invitation.
- Find out from Clerk's current docs and from Dom what the production instance's home URL is used for by the other apps. Don't change it without Dom's say-so.
- Check whether an invitation with `redirect_url` pointing at `/sign-up` consumes the ticket. That route renders Clerk's `<SignUp>` (`apps/web/src/routes/sign-up.tsx:11`), and the WS.2 run only tried `/`, which has no form. I have not tested this.
- If the invitee doesn't reach Harbourmaster without the dashboard change, send invitations with a `redirect_url` to the route that works. Clerk's profile sends none, so this needs an app-side invite call and changes WS.2's "no invite screens" decision. That needs Dom's call.
- Name any dashboard change in the `Dom:` line, and state how restricted sign-up behaves.

Check:
- A brand-new user accepts on staging and lands on `/desk` in the inviting workspace.
- An existing user does the same.
- An uninvited sign-up is still refused under restricted sign-up.

### M2: add-clerk dev login makes the row

Scope:
- Add the `import.meta.env.DEV` block from `apps/web/src/server.ts:179` to the snippet at `.claude/skills/add-clerk/SKILL.md:112`, and update the snippet's header comment to match.

Check:
- The snippet's handler matches the `/api/dev-login` handler in `apps/web/src/server.ts`.
- Following the skill in a fresh copy, with `.wrangler` deleted, one-click dev login lands on `/desk`.

## Access paths checked, nothing found

- Session (tRPC over HTTP and SSR, plus desktop, library, connectors, artifacts, files and session-stream routes): all go through `sessionPrincipal`, which reads the row and creates nothing.
- Bearer, MCP and OAuth: `createPrincipalResolver` needs the row for every token kind, and user tokens also need membership. A first-seen OAuth client needs a row among the Clerk-listed organisations, or it gets `no_workspace`.
- Machine and trigger `authenticate`: read the row.
- Live artifacts: `freshMember` needs a room org and a fresh membership, then the row through `sessionPrincipal`. `app-grants.ts` and `shares.ts` still need `isOrgMember`, which refuses by default in `compose.ts:563`, so removing their empty-list default opened nothing.
- Routines tick: fires for every workspace, and an empty list no longer stops it. The foreign key means a trigger always has a row. This is what the rollout comparison covers: on the production deploy, routines and triggers in rows outside the old list start firing.
- `workspaces.create`: reached only through `workspaceProcedure`, and `createFromSession` refuses anything but `kind: user`, `via: session`, `isAdmin: true`. `getAuth` without `acceptsToken` defaults to session tokens only, so an OAuth or API token on `/api/trpc` is signed out. `csrf()` covers the route. No MCP tool or other route calls it. The input takes only a name.
- `workspaces.mine`: uses the session's `userId` with no client input and leaves out organisations with no row, so another person's organisations can't appear.
- Dev-login row: the `import.meta.env.DEV` branch is gone from `apps/web/dist/server/index.js` in a production build. `.env.staging` sets no `NODE_ENV`, so a `--mode staging` build should strip it too, though I did not build that mode.
- `add-workspace`: the org id is pattern-checked, the SQL is quoted, the Clerk instance matches the target, and `--env` accepts only `staging`.

## Checks run

- `bun run check`: pass.
- `bun run test`: pass, 0 failures in every package, including services 3917 and web 4005.
- `bun run build`: pass, with `apps/web/.env` copied from `.env.example`.
- Grep of `apps/web/dist/client` for `drizzle`: 0 files.
- Task grep for `ALLOWED_ORG_IDS` and `allowedOrgIds`: nothing.

Not run: `bun scripts/e2e/a2a-two-deployments.ts` and the browser checks, because this checkout has no `.env.local`. The WS.1 and WS.2 notes report them, except the brand-new invitee in M1, and I did not repeat them.
