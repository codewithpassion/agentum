import {
  ComputerTransportError,
  REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
  type Transport,
} from "./remote-client";
import type { ComputerHost } from "./schema";

/**
 * The Fly transport: `POST https://<app>.fly.dev/op` with the host's daemon
 * token as a bearer credential and `fly-force-instance-id: <machineId>`, so
 * Fly's proxy routes the request to that agent's machine and starts it if it
 * was stopped (docs/plan-computer-backends.md §4).
 *
 * The dispatcher in `client.ts` builds this for `computer: "fly"` agents, the
 * protocol and its reply checking live in `remote-client.ts`, and the token
 * comes from `resolveHostToken`, the only place a Fly host's token is
 * decrypted.
 *
 * Notes worth not rediscovering:
 * - the URL is derived from `host.config.app`, which the create route requires
 *   for `fly` hosts, so it is present on any host that reaches here;
 * - `machineId` comes from `agents.computer_ref` and is per agent, not per
 *   host - one Fly app holds a machine per agent;
 * - every request also counts as "in use" for the machine's idle auto-stop, so
 *   there is nothing to call to keep it awake;
 * - failures a person can act on are thrown as `ComputerTransportError`; its
 *   message reaches the agent verbatim. Anything else becomes a generic
 *   unreachable reason.
 */

export interface FlyTransportOptions {
  /** The seam tests replace; nothing here may reach a real network in a test. */
  fetchImpl?: typeof fetch;
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

/**
 * How much longer than the command itself we are willing to wait: the cold
 * start of a stopped machine plus the round trip. Below the command's own
 * deadline the daemon's answer - "it timed out, here is the output so far" -
 * would be thrown away in favour of a much less useful "no reply".
 */
export const FLY_TIMEOUT_GRACE_MS = 20_000;

const MILLIS_PER_SECOND = 1000;

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;

/**
 * The daemon caps `exec` itself, and `remote-client` already clamps what it
 * sends; this reads the clamped value back off the message so one request's
 * deadline follows the command it carries rather than a fixed ceiling.
 */
export const flyRequestTimeoutMs = (
  message: Record<string, unknown>
): number => {
  const asked = message.timeoutMs;
  const wanted =
    typeof asked === "number" && Number.isFinite(asked) && asked > 0
      ? Math.min(asked, REMOTE_EXEC_MAX_TIMEOUT_MS)
      : REMOTE_EXEC_DEFAULT_TIMEOUT_MS;
  return wanted + FLY_TIMEOUT_GRACE_MS;
};

const reasonForStatus = (status: number): string => {
  if (status === UNAUTHORIZED || status === FORBIDDEN) {
    return `The Fly machine for this agent rejected this server's token (HTTP ${status}). Rotate the computer host's token in Settings so its machines are given the new one.`;
  }
  if (status === NOT_FOUND) {
    return "The Fly machine for this agent could not be found (HTTP 404). It may have been deleted in Fly; recreate the agent to get a new one.";
  }
  return `The Fly machine for this agent is not responding (HTTP ${status}). It may still be starting; try again in a few seconds.`;
};

/**
 * One round trip, with the caller holding the deadline. Split out so the
 * timeout covers the body as well as the headers: a machine that answered and
 * then stalled mid-reply must not be waited on forever.
 */
const roundTrip = async (
  options: FlyTransportOptions,
  app: string,
  message: Record<string, unknown>,
  controller: AbortController,
  timeoutMs: number
): Promise<unknown> => {
  const send = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await send(flyOpUrl(app), {
      body: JSON.stringify(message),
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        ...(options.machineId
          ? { "fly-force-instance-id": options.machineId }
          : {}),
      },
      method: "POST",
      signal: controller.signal,
    });
  } catch (error) {
    // Either the deadline fired or the connection never came up. Both are
    // "nothing answered", and neither may leak a socket error to the agent -
    // it rides along as the cause, where only a log will ever see it.
    throw new ComputerTransportError(
      controller.signal.aborted
        ? `The Fly machine for this agent did not answer within ${Math.round(timeoutMs / MILLIS_PER_SECOND)} seconds.`
        : "The Fly machine for this agent could not be reached. It may still be starting; try again in a few seconds.",
      { cause: error }
    );
  }

  if (!response.ok) {
    throw new ComputerTransportError(reasonForStatus(response.status));
  }

  try {
    return await response.json();
  } catch (error) {
    throw new ComputerTransportError(
      "The Fly machine for this agent answered with something that was not JSON. Check that its computerd image matches this deployment.",
      { cause: error }
    );
  }
};

export const createFlyTransport = (
  _env: Env,
  options: FlyTransportOptions
): Transport => ({
  async send(message) {
    const { app } = options.host.config;
    if (!app) {
      throw new ComputerTransportError(
        `The computer host "${options.host.name}" has no Fly app configured. Set one in Settings and try again.`
      );
    }

    const timeoutMs = flyRequestTimeoutMs(message);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await roundTrip(options, app, message, controller, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  },
});
