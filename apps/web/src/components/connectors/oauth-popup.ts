import type { Api, Connector } from "#/lib/api";

/**
 * The popup half of the authorization-code flow.
 *
 * Two details are load-bearing. The window is opened blank *during the click*
 * and navigated once the server hands back an authorize URL - a browser blocks
 * `window.open` called after an `await`, so opening it later would silently
 * fail. And the callback page's `postMessage` is treated as a hurry-up, not as
 * the answer: the flow is completed server-side, so the connector row is the
 * only thing worth believing, and a popup the human closed by hand still
 * resolves on the next poll.
 */

const POPUP_FEATURES = "popup=yes,width=560,height=760";
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const CALLBACK_MESSAGE = "agentum:connector-oauth";

/** Call this synchronously from the click handler, before any `await`. */
export const openBlankPopup = (): Window | null =>
  window.open("about:blank", "agentum-connector-oauth", POPUP_FEATURES);

/** Resolves on the callback's message, on the next tick, or on abort. */
const settleOrTick = (signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null;
      if (
        event.origin === window.location.origin &&
        data?.type === CALLBACK_MESSAGE
      ) {
        finish();
      }
    };
    const timer = window.setTimeout(finish, POLL_INTERVAL_MS);
    window.addEventListener("message", onMessage);
    signal?.addEventListener("abort", finish);
  });

/**
 * Waits for the connector to leave `authorizing`, whichever way it goes: the
 * caller reads the returned row's status rather than a boolean, because
 * "the callback ran and the exchange failed" is a real outcome with a message.
 */
export const waitForAuthorization = async (
  api: Api,
  connectorId: string,
  signal?: AbortSignal
): Promise<Connector> => {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // Polling is inherently serial, and each round is one small GET.
    // biome-ignore lint/performance/noAwaitInLoops: a poll loop, not a fan-out
    await settleOrTick(signal);
    if (signal?.aborted) {
      throw new Error("Authorization was cancelled.");
    }
    const { connector } = await api.getConnector(connectorId);
    if (connector.status !== "authorizing") {
      return connector;
    }
  }

  throw new Error(
    "The authorization did not finish. Try Re-authorize from the connector."
  );
};
