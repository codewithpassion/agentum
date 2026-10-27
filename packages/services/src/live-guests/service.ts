import { findGuestSessionGrant } from "@repo/db/live-guests";
import { hashToken } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
/** Composition only; no application route/runtime imports this backend. */
import type { RunsService } from "../runs.ts";
import { createGuestAccessReader } from "./access.ts";
import { createGuestAuthService, type GuestAuthDeps } from "./auth.ts";
import { createGuestInvitations } from "./invitations.ts";
import { createGuestRunStarter } from "./runs.ts";
import { createGuestSessionLifecycle } from "./sessions.ts";
import { createGuestSwitch } from "./switch.ts";

type InvitationDeps = Parameters<typeof createGuestInvitations>[0];
export interface LiveGuestsDeps extends Omit<InvitationDeps, "inviterName"> {
  inviterName: GuestAuthDeps["inviterName"];
  pepper: GuestAuthDeps["pepper"];
  /** Omit until scoped runtimes/tools are integrated. */
  runs?: Pick<RunsService, "startForGuest">;
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
    setEnabled: createGuestSwitch(deps),
    ...auth,
    ...sessions,
    async details(input: {
      workspaceId: string;
      artifactId: string;
      sessionToken: string;
    }) {
      if (!(await access.resolve(input))) {
        throw new ServiceError("not_found", "Guest access unavailable");
      }
      const row = await findGuestSessionGrant(deps.db, {
        ...input,
        at: deps.clock.now().toISOString(),
        tokenHash: await hashToken(input.sessionToken),
      });
      if (!row) {
        throw new ServiceError("not_found", "Guest access unavailable");
      }
      const inviterName = await deps.inviterName({
        userId: row.createdBy,
        workspaceId: row.workspaceId,
      });
      if (!(await access.resolve(input))) {
        throw new ServiceError("not_found", "Guest access unavailable");
      }
      return {
        guestName: row.guestName,
        inviterName,
        workspaceName: row.workspaceName,
      };
    },
    async invitation(workspaceId: string, token: string) {
      const metadata = await access.invitation(workspaceId, token);
      if (!metadata) {
        return null;
      }
      const { createdBy, ...landing } = metadata;
      const inviterName = await deps.inviterName({
        userId: createdBy,
        workspaceId,
      });
      return deps.guestsOff() ? null : { ...landing, inviterName };
    },
    resolve: access.resolve,
    startRun: createGuestRunStarter({ access, runs: deps.runs }).start,
  };
};
export type LiveGuestsService = Awaited<
  ReturnType<typeof createLiveGuestsService>
>;
