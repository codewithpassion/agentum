import { ComputerTransportError } from "./remote-client";

/**
 * Fly cannot wake an outbound-only machine: its proxy starts machines on
 * inbound traffic, and this client sends none. So before an operation reaches a
 * Fly host the relay is asked whether the client is connected, and if it is not
 * the machine is started through the Machines API and the relay is polled until
 * the client's hello arrives.
 */

export const WAKE_POLL_MS = 1000;
export const WAKE_TIMEOUT_MS = 45_000;

export interface WakeOptions {
  /** Whether the client currently holds its WebSocket to the relay. */
  isConnected: () => Promise<boolean>;
  /** What to call the computer in the message the agent reads. */
  label: string;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Starts the machine. A failure is kept for the timeout message, not thrown. */
  start: () => Promise<void>;
  timeoutMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";

/**
 * Resolves once the client is connected; throws a `ComputerTransportError`
 * whose text the agent reads if it is not within the timeout.
 *
 * A failed start does not stop the wait: two operations racing to wake the same
 * machine make the second start fail, and the machine comes up anyway. The
 * failure is only reported if the client never shows up.
 */
export const createEnsureConnected = (
  options: WakeOptions
): (() => Promise<void>) => {
  const pollMs = options.pollMs ?? WAKE_POLL_MS;
  const timeoutMs = options.timeoutMs ?? WAKE_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;

  return async () => {
    if (await options.isConnected()) {
      return;
    }

    let startError: string | null = null;
    try {
      await options.start();
    } catch (error) {
      startError = messageOf(error);
    }

    const polls = Math.ceil(timeoutMs / pollMs);
    const waitForClient = async (remaining: number): Promise<boolean> => {
      if (remaining === 0) {
        return false;
      }
      await sleep(pollMs);
      return (
        (await options.isConnected()) || (await waitForClient(remaining - 1))
      );
    };
    if (await waitForClient(polls)) {
      return;
    }

    throw new ComputerTransportError(
      `${options.label} did not come online within ${Math.round(timeoutMs / 1000)} seconds after it was started${startError ? ` (starting it failed: ${startError})` : ""}. Try again in a minute, or check the host in Settings.`
    );
  };
};
