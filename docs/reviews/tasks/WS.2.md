# WS.2 review notes

Task: switch workspace, create one, and manage members from the rail header.

## Verdicts

- Round 1 (169336407): not clean. Two must-fix items. Manage members opened Clerk's modal without closing the mobile sheet. A retry after a failed switch in the New workspace dialog could create a second workspace.
- Round 2 (be81573a2, fix commit only): clean.

Both must-fix items are fixed. The sheet closes before Clerk's modal opens, and the dialog keeps the created organisation id so a retry only switches. Choosing the current workspace is a no-op, the dialog resets on close, and NoAccess reads "This session has no Harbourmaster workspace" when no organisation is active.

## Browser run (Clerk dev instance, `bun run dev` on port 4318)

- New workspace by an admin created the Clerk organisation (admin delete off, confirmed through the Backend API) and the row, and landed in the new workspace.
- Switching back to Dev Workspace reloaded `/desk` with that workspace's data.
- A non-admin (`hm-member2`) saw the workspaces and Manage members, no New workspace.
- Manage members opens Clerk's organisation profile with Members and Invite.
- NoAccess with an active organisation that has no row says "<org> has no Harbourmaster workspace" and lists only organisations with a row.
- The 360px sheet shows the menu, long names wrap.
- Invitations: sent from the UI, the invitation carries no redirect URL, so Clerk sends the invitee to the instance's hosted sign-up (`accounts.dev/sign-up`), not the app's `/sign-up`. An invitation made through the API with `redirect_url` lands on `/` with `__clerk_status=sign_up&__clerk_ticket=...` and the signed-out page, which does not render a sign-up form. I could not finish a sign-up as a brand-new user: the hosted page stops at Clerk's bot `protect-check` in headless Chrome. So "accept as a brand-new user and arrive in the workspace" is not verified.

## Nits left

- The New workspace dialog can be closed while the request runs, which leaves a stale ref and error on reopen. The name stays editable after a failed switch although a retry ignores it.
- After a failed switch the new workspace is missing from the menu for up to 5 minutes (`MINE_POLL_MS`).
- A failed `workspaces.mine` is ignored: NoAccess then says "Ask a workspace admin to invite you", and the menu lists nothing.
- The rail polls `workspaces.mine`, which is an uncached Clerk Backend API call per refresh and per window focus.
- `mine` uses `inArray`, which D1 limits to 100 parameters. A person in more than 100 organisations makes it throw. `firstForOrgs` has the same limit. The client reads only the first 100 Clerk memberships for names.

## Beyond the scope

- Existing workspace organisations (made by `add-workspace`) still have admin delete on, so Manage members shows their admins a Delete organization button that would strand the workspace data. Fix with a one-off `updateOrganization({ adminDeleteEnabled: false })` on each, or turn the setting off for the instance.
- `/choose-organization` (`TaskChooseOrganization`) was left alone and not exercised. It can create an organisation and lists other apps' on a shared instance. Picking one with no row lands on NoAccess, which now explains it.
- `Members` and `New workspace` are not in Find: they are actions, and the registry holds plain routes.
- A tiny `cachedMembers`-style cache for `userOrganizations` would cut the Clerk calls.

## Steps for Dom

- Invitations to a brand-new user are unverified end to end. Send one on staging with a real inbox, accept it, and check the invitee arrives in the workspace. In the Clerk dashboard (production instance), set the Account Portal / application home URL so the hosted sign-up returns to the app, and keep restricted sign-up on: an invitation ticket is what lets an invited email through restricted sign-up (confirm this on staging).
- Decide whether to turn admin delete off on the existing workspace organisations.
- During the browser run, `pkill -f agent-browser` killed the shared agent-browser daemon, so other agents' sessions on it may have dropped.
