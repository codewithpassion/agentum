/** Composition only; no application route/runtime imports this backend. */
import { createGuestAccessReader } from "./access.ts";
import { createGuestAuthService, type GuestAuthDeps } from "./auth.ts";
import { createGuestInvitations } from "./invitations.ts";
import { createGuestSessionLifecycle } from "./sessions.ts";

type InvitationDeps = Parameters<typeof createGuestInvitations>[0];
export interface LiveGuestsDeps extends Omit<InvitationDeps, "inviterName"> {
  inviterName: GuestAuthDeps["inviterName"];
  pepper: GuestAuthDeps["pepper"];
}
/** Authenticated app members use invite/changeRole/revoke. Only guest HTTP
 * adapters may call the separate invitation/requestCode/verify/open/renew/
 * signout/resolve API; resolve is not an application Principal resolver.
 */
export const createLiveGuestsService = async (deps: LiveGuestsDeps) => {
  const invitations = createGuestInvitations({
    ...deps,
    inviterName: (user) =>
      deps.inviterName({ userId: user.userId, workspaceId: user.workspaceId }),
  });
  const auth = await createGuestAuthService(deps);
  const access = createGuestAccessReader(deps);
  const sessions = createGuestSessionLifecycle(deps);
  return {
    ...invitations,
    ...auth,
    ...sessions,
    invitation: access.invitation,
    resolve: access.resolve,
  };
};
export type LiveGuestsService = Awaited<
  ReturnType<typeof createLiveGuestsService>
>;
