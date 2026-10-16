import type { ManagedPollerPort } from "@repo/services/managed/types";
import type { ManagedPoller } from "./managed-poller.ts";

/** The services' view of the poller: one Durable Object per managed run, by run id. */
export const durablePollerPort = (
  namespace: DurableObjectNamespace<ManagedPoller>
): ManagedPollerPort => {
  const pollerOf = (runId: string) =>
    namespace.get(namespace.idFromName(runId));
  return {
    cancel: (runId) => pollerOf(runId).cancelRun(runId),
    kick: (runId) => pollerOf(runId).kick(runId),
  };
};
