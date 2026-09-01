import { ComputerTransportError, type Transport } from "./remote-client";

/**
 * The self-hosted transport: an RPC into the `ComputerRelay` Durable Object
 * (`idFromName(hostId)`), which writes the message to the daemon's WebSocket
 * and resolves with the matching reply (docs/plan-computer-backends.md §6).
 *
 * **A stub.** Track 4 (the relay) fills `send` in and adds the DO class, its
 * `COMPUTER_RELAY` binding and the connect route; nothing else in this module
 * has to change, because the dispatcher in `client.ts` already builds this for
 * `computer: "self_hosted"` agents and `remote-client.ts` already owns the
 * protocol and the reply checking.
 *
 * Notes track 4 should not have to rediscover:
 * - the host is addressed by id alone - `findHostByToken` in `hosts.ts` is what
 *   turns the daemon's presented token into that id at connect time;
 * - a request that finds no socket must fail immediately with the offline
 *   reason rather than waiting, and `ComputerTransportError`'s message reaches
 *   the agent verbatim - that is where "start the container and try again"
 *   belongs, with `lastSeenAt` from the host row;
 * - `setHostStatus` and `touchHostSeen` in `hosts.ts` are the writes for
 *   connect, heartbeat and the missed-heartbeat window.
 */

// `_env` is unused only until track 4 lands: the signature is the one the
// dispatcher already calls with, so filling `send` in touches nothing else.
export const createRelayTransport = (_env: Env, hostId: string): Transport => ({
  send: () =>
    Promise.reject(
      new ComputerTransportError(
        `Self-hosted computers are not available in this deployment yet (host ${hostId}). Not implemented yet: track 4.`
      )
    ),
});
