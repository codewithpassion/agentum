/** One workspace the person belongs to, as `workspaces.mine` returns it. */
export interface WorkspaceRow {
  clerkOrgId: string;
}

/**
 * Returns the organisation id when the person belongs to exactly one
 * organisation that has a `workspaces` row, and undefined otherwise. `mine` is
 * the server's list, which already leaves out every organisation without a
 * row, so an organisation of another app on the shared Clerk instance never
 * counts. Callers must wait until the list has loaded, since an unloaded list
 * reads as empty. Used to activate the person's only workspace after a sign-in
 * with no active organisation.
 */
export const soleWorkspaceOrgId = (
  mine: readonly WorkspaceRow[] | undefined
): string | undefined => {
  if (mine === undefined || mine.length !== 1) {
    return;
  }
  return mine[0]?.clerkOrgId;
};
