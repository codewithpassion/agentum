/** Cookie-authenticated guest run entry point; never creates a Principal.
 * HTTP rotation/open logging remains the adapter's responsibility. */

import { guestUnavailable } from "../runs/guest-scope.ts";
import type { StartRunInput } from "../runs/types.ts";
import type { RunsService } from "../runs.ts";
import type { createGuestAccessReader } from "./access.ts";

export const createGuestRunStarter = (deps: {
  access: ReturnType<typeof createGuestAccessReader>;
  runs?: Pick<RunsService, "startForGuest">;
}) => ({
  async start(input: {
    artifactId: string;
    workspaceId: string;
    sessionToken: string;
    run: StartRunInput;
    sessionId?: string;
  }) {
    const grant = await deps.access.resolve(input);
    if (!(grant && deps.runs)) {
      throw guestUnavailable();
    }
    return deps.runs.startForGuest(grant, input.run, {
      guestSessionToken: input.sessionToken,
      offerLater: true,
      sessionId: input.sessionId,
    });
  },
});
