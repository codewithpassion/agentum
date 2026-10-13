import type { RelayStatus } from "./relay";
import {
  ComputerTransportError,
  type SessionRoot,
  type Transport,
} from "./remote-client";

/**
 * The self-hosted transport: an RPC into the `ComputerRelay` Durable Object
 * (`idFromName(hostId)`), which writes the message to the daemon's WebSocket and
 * resolves with its outcome.
 *
 * A client error from the daemon is handed back as the reply envelope, so the
 * remote client keeps its code. Every connection-level failure becomes a
 * `ComputerTransportError`, whose message is shown to the agent verbatim.
 */

const UNREACHABLE = "The computer host could not be reached.";

/** An agent id becomes a directory name on the host, so only plain characters pass. */
const SAFE_DIRECTORY_NAME = /^[A-Za-z0-9_-]+$/;

const relayStub = (env: Env, hostId: string) =>
  env.COMPUTER_RELAY.get(env.COMPUTER_RELAY.idFromName(hostId));

export const createRelayTransport = (env: Env, hostId: string): Transport => ({
  send: async (message) => {
    const outcome = await relayStub(env, hostId)
      .request(message)
      .catch((error: unknown) => {
        throw new ComputerTransportError(
          error instanceof Error ? error.message : UNREACHABLE,
          { cause: error }
        );
      });
    if (outcome.ok) {
      return {
        id: message.id,
        result: JSON.parse(outcome.result_json ?? "{}") as Record<
          string,
          unknown
        >,
      };
    }
    if (outcome.reason === "client_error") {
      return {
        error: { code: outcome.code, message: outcome.message },
        id: message.id,
      };
    }
    throw new ComputerTransportError(outcome.message, {
      timedOut: outcome.reason === "timeout",
    });
  },
  status: async () => {
    try {
      const { connected, hostname, version } = await relayStub(
        env,
        hostId
      ).status();
      return { connected, hostname, version };
    } catch (error) {
      throw new ComputerTransportError(
        error instanceof Error ? error.message : UNREACHABLE,
        { cause: error }
      );
    }
  },
});

/**
 * The directory an agent's files live in on a self-hosted host: a child of the
 * workdir the daemon reported in its hello. Until a hello has arrived there is
 * no workdir, and nothing can be placed.
 */
export const createRelaySessionRoot =
  (env: Env, hostId: string, agentId: string): SessionRoot =>
  async () => {
    if (!SAFE_DIRECTORY_NAME.test(agentId)) {
      return {
        ok: false,
        reason: "This agent's id cannot name a directory on the computer.",
      };
    }
    let status: RelayStatus;
    try {
      status = await relayStub(env, hostId).status();
    } catch {
      return { ok: false, reason: UNREACHABLE };
    }
    if (status.workdir === null) {
      return {
        ok: false,
        reason:
          "The computer has not reported its working directory yet. Start the container and try again.",
      };
    }
    return { ok: true, path: `${status.workdir}/${agentId}` };
  };
