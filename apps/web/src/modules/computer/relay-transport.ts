import { ComputerTransportError, type Transport } from "./remote-client";

/**
 * The self-hosted transport: an RPC into the `ComputerRelay` Durable Object
 * (`idFromName(hostId)`), which writes the message to the daemon's WebSocket
 * and resolves with the matching reply (docs/plan-computer-backends.md §6).
 *
 * There is nothing here but the hop, because the relay already owns everything
 * that could go wrong on it: the offline reason for a host with no socket, the
 * per-request timeout, and one `exec` in flight at a time. What this does own
 * is the error type - the relay throws plain `Error`s, since that is all that
 * survives an RPC boundary, and `remote-client.ts` shows a
 * `ComputerTransportError`'s message to the agent verbatim while turning
 * anything else into a generic "could not be reached".
 */

export const createRelayTransport = (env: Env, hostId: string): Transport => ({
  send: async (message) => {
    const stub = env.COMPUTER_RELAY.get(env.COMPUTER_RELAY.idFromName(hostId));
    try {
      return await stub.request(message);
    } catch (error) {
      throw new ComputerTransportError(
        error instanceof Error
          ? error.message
          : "The computer host could not be reached.",
        { cause: error }
      );
    }
  },
});
