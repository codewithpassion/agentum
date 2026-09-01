import { ComputerTransportError, type Transport } from "./remote-client";
import type { ComputerHost } from "./schema";

/**
 * The Fly transport: `POST https://<app>.fly.dev/op` with the host's daemon
 * token as a bearer credential and `fly-force-instance-id: <machineId>`, so
 * Fly's proxy routes the request to that agent's machine and starts it if it
 * was stopped (docs/plan-computer-backends.md §4).
 *
 * **A stub.** Track 3 (the Fly gateway) fills `send` in; everything around it
 * is already wired, so that track needs to touch no other file here: the
 * dispatcher in `client.ts` builds this for `computer: "fly"` agents, the
 * protocol and its reply checking live in `remote-client.ts`, and the token
 * comes from `resolveHostToken`, the only place a Fly host's token is
 * decrypted.
 *
 * Notes track 3 should not have to rediscover:
 * - the URL is derived from `host.config.app`, which the create route requires
 *   for `fly` hosts, so it is present on any host that reaches here;
 * - `machineId` comes from `agents.computer_ref` and is per agent, not per
 *   host - one Fly app holds a machine per agent;
 * - every request also counts as "in use" for the machine's idle auto-stop, so
 *   there is nothing to call to keep it awake;
 * - failures a person can act on ("the machine is stopped and would not
 *   start") should be thrown as `ComputerTransportError`; its message reaches
 *   the agent verbatim. Anything else becomes a generic unreachable reason.
 */

export interface FlyTransportOptions {
  host: ComputerHost;
  /**
   * The Fly machine that holds this agent's computer, sent as
   * `fly-force-instance-id`. Null asks the proxy for any machine in the app,
   * which is what a host-level ping wants and what agent traffic never does.
   */
  machineId: string | null;
  /** The daemon token, already decrypted by `resolveHostToken`. */
  token: string;
}

/** `https://<app>.fly.dev/op` - the address the Fly proxy answers on. */
export const flyOpUrl = (app: string): string => `https://${app}.fly.dev/op`;

// `_env` is unused only until track 3 lands: the signature is the one the
// dispatcher already calls with, so filling `send` in touches nothing else.
export const createFlyTransport = (
  _env: Env,
  options: FlyTransportOptions
): Transport => ({
  send: () =>
    Promise.reject(
      new ComputerTransportError(
        `Fly computers are not available in this deployment yet (host "${options.host.name}"). Not implemented yet: track 3.`
      )
    ),
});
