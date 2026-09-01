import type { Db } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";

/**
 * What a deleted agent leaves behind on its computer backend, and whose job it
 * is to clear it. Called from the agents delete route with the row as it was
 * just before deletion - `computer`, `computerHostId` and `computerRef` are
 * all still on it, which is the only reason the call is placed there and not
 * after.
 *
 * Deliberately not part of `deleteAgent`: the agent row is D1 and this is a
 * third party's API, so a Fly outage must not be able to fail a deletion the
 * user asked for. Failures here are logged by the caller and leave orphans
 * that the host page can show, which is the honest trade.
 */
export const onAgentComputerDeleted = async (
  _db: Db,
  _env: Env,
  agent: Agent
): Promise<void> => {
  if (agent.computer !== "fly") {
    // `cloudflare`: the Durable Object is addressed by the agent id, so a
    // deleted agent's computer is simply never reached again.
    // `self_hosted`: the container and its volume are the user's, on the
    // user's machine. Nothing here may touch them.
    return;
  }

  // TODO(track 3 - Fly): stop and delete the machine, then delete the volume,
  // both from `agent.computerRef` (`{ machineId, volumeId }`), through the
  // FlyGateway keyed on the host's API token. The host is
  // `getHostByIdUnscoped(db, agent.computerHostId)` and the token comes from
  // `resolveFlyApiToken(env, host)` in `hosts.ts`; the order matters, because
  // Fly refuses to delete a volume still attached to a machine. Both
  // parameters are underscored only because nothing reads them yet - drop the
  // underscore rather than changing the signature the delete route calls.
  await Promise.resolve();
};
