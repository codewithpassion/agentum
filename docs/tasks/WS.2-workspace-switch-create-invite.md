---
id: WS.2
title: "Switch workspace, create one, and invite people"
milestone: WS
size: M
status: in_progress
depends_on: [WS.1, RL.10]
branch: task/WS.2-workspace-switch-create-invite
lane: web
executor: claude
---

Dom's request, 2 November 2026: there is no way to create a new workspace, invite or assign people, or swap workspaces on the fly. Workspace admins create workspaces in the app.

## Decisions
- The workspace name in the rail header (its own row since RL.10) becomes a menu: the person's workspaces with the current one marked, then `Manage members` and `New workspace`.
- Build this menu rather than use Clerk's `OrganizationSwitcher`. That component lists every organisation the person belongs to, including other apps' on the shared production instance, and its create button makes an organisation with no workspace row. The menu shows only organisations that have a row.
- `New workspace` shows only to an `org:admin` of the current workspace, and the server enforces it. It takes a name. The creator becomes the new organisation's admin and lands in it.
- Invites and member roles come from Clerk's organisation profile (`openOrganizationProfile`), so this task builds no invite screens. Any member can open it, and Clerk limits what a non-admin can do there.
- Switching ends in a full page load to `/desk`, because loaders, polls and the rail hold the old workspace's data. `PendingSessionGate` already does the same for the same reason.

## Scope
- `packages/services/src/workspaces.ts`: `createFromSession(principal, { name })`. It refuses anyone but a browser-session `org:admin` (no API key, OAuth client, run, machine or trigger), trims and bounds the name, and makes the Clerk organisation through an injected port with `createdBy` set to the caller, then the row through WS.1's create. If the row fails, it deletes the organisation it just made. The Clerk port is wired in `compose.ts`; the service never reads `env`. Turn off admin delete on the new organisation (`adminDeleteEnabled`), because deleting one in Clerk would strand its workspace data.
- A read of "my workspaces" for a signed-in person, whether or not the active organisation has access: Clerk's memberships for the session's user, joined to the rows, returning org id and role. Names come from Clerk on the client so a rename shows. It needs a procedure for a signed-in user with no workspace, because `workspaceProcedure` answers 401 there. If that changes `context.ts`, change the `add-clerk` copy too. Never trust a list of org ids from the client.
- `apps/web/src/server/trpc/`: the router for both, thin.
- `apps/web/src/components/rail/`: the workspace menu, with its name logic in a tested helper. It uses `useOrganizationList` and `setActive`, then `window.location.assign("/desk")`. A workspace that fails to switch stays put and shows the error. With one workspace and no admin rights it is still a menu, for `Manage members`. The full name must show or wrap, not cut off at 20 characters.
- `apps/web/src/routes/index.tsx` `NoAccess`: replace `OrganizationSwitcher` with the same list, using the words "has no Harbourmaster workspace". A person in no workspace at all sees that and `Sign out`.
- `apps/web/src/routes/choose-organization.tsx`: `TaskChooseOrganization` can create an organisation and lists other apps' on the shared instance. Picking one lands on `NoAccess`, which now explains it. Leave the component unless the browser check shows a dead end, and report what it does.
- Find: add `Members` and `New workspace` only if they fit the registry's model of plain routes. Otherwise leave them in the menu and say so in the review notes.
- `docs/ux-review/rail/spec.md` and `CLAUDE.md` Auth: describe the menu.

## Check
- Service tests: an admin creates a workspace and gets a row and an organisation, a non-admin and each non-session principal are refused, a failed row insert deletes the organisation, and a blank or oversized name is refused.
- "My workspaces" leaves out an organisation with no row and another person's organisation.
- Browser, on the Clerk dev instance, with two users: create a workspace and land in it empty, switch back and see the first one's desk with no leftovers from the second, invite the second user by email, accept the invitation as a brand-new user, and arrive in the workspace. A non-admin sees no `New workspace`. Check the 360px phone sheet.
- Confirm from Clerk's current docs, and in that browser run, how invitations behave under restricted sign-up. If production needs a dashboard change, name it in the `Dom:` line.
- `bun run check && bun run test && bun run build`, and the grep of `apps/web/dist/client` for `drizzle` finds nothing.

## Log
- 2026-11-02: created from Dom's request.
- 2026-11-02: dispatched.
