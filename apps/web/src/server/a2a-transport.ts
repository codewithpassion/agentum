/**
 * How this deployment reaches its peers over A2A. `createPeerFetch` is the
 * `A2aFetch` the outbox and the client use: it refuses private addresses,
 * plain http outside dev, credentials and redirects, times out, and answers
 * requests for its own origin in-process. The pairing transport and the card
 * fetcher are built on top of it.
 */

import type { A2aFetch } from "@repo/a2a/peer-fetch";
import type { PairingTransport } from "@repo/services/a2a/connections";
import { safeFetch } from "@repo/services/connectors/safe-url";
import { ServiceError } from "@repo/services/errors";

export interface PeerFetchOptions {
  /** Plain http, and a peer on localhost, are allowed (dev builds only). */
  allowHttp: boolean;
  /** The network. A bare `fetch` loses its receiver in workerd, so the caller wraps it. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Handles a request for this deployment's own origin in-process. A Worker cannot fetch its own hostname. */
  localFetch?: (request: Request) => Promise<Response>;
  /** `PUBLIC_BASE_URL`. A request to this origin goes to `localFetch`. */
  publicBaseUrl?: string;
  /** Default 15_000. */
  timeoutMs?: number;
}

export const PEER_FETCH_TIMEOUT_MS = 15_000;
const CARD_MAX_BYTES = 262_144;
const REDIRECT_MIN = 300;
const REDIRECT_END = 400;

const isRedirect = (status: number): boolean =>
  status >= REDIRECT_MIN && status < REDIRECT_END;

/** The origin of a URL, or null when it does not parse. */
const originOf = (raw: string): string | null => {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
};

/** Rejects with the signal's reason when it aborts. Never resolves otherwise. */
const timedOut = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

const refused = (reason: string): Error =>
  new Error(`Request to a peer refused: ${reason}`);

export const createPeerFetch = (options: PeerFetchOptions): A2aFetch => {
  const timeoutMs = options.timeoutMs ?? PEER_FETCH_TIMEOUT_MS;
  const { allowHttp, fetch: network, localFetch, publicBaseUrl } = options;
  const selfOrigin =
    publicBaseUrl === undefined ? null : originOf(publicBaseUrl);

  return async (url, init) => {
    const origin = originOf(url);
    if (localFetch && selfOrigin !== null && origin === selfOrigin) {
      const signal = AbortSignal.timeout(timeoutMs);
      const request = new Request(url, {
        ...init,
        redirect: "manual",
        signal,
      });
      // The app's handler is not bound to the signal, so the wait is raced with it.
      const response = await Promise.race([
        localFetch(request),
        timedOut(signal),
      ]);
      if (isRedirect(response.status)) {
        throw refused("redirect");
      }
      return response;
    }
    const result = await safeFetch(network, url, init, {
      allowHttp,
      allowLoopback: allowHttp,
      timeoutMs,
    });
    if (!result.ok) {
      throw refused(result.reason);
    }
    return result.response;
  };
};

/** Reads the body as text, refusing one over `maxBytes`. */
const readBounded = async (
  response: Response,
  maxBytes: number
): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  const tooLarge = `Agent card is larger than ${maxBytes} bytes`;
  if (declared > maxBytes) {
    throw new Error(tooLarge);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  let next = await reader.read();
  while (!next.done) {
    total += next.value.byteLength;
    if (total > maxBytes) {
      // biome-ignore lint/performance/noAwaitInLoops: Stops the read, then leaves the loop.
      await reader.cancel();
      throw new Error(tooLarge);
    }
    text += decoder.decode(next.value, { stream: true });
    next = await reader.read();
  }
  return text + decoder.decode();
};

const parseJson = async (
  response: Response,
  what: string
): Promise<unknown> => {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`The ${what} answer is not JSON`, { cause: error });
  }
};

const JSON_HEADERS = { "Content-Type": "application/json" };

const CLIENT_ERROR_MIN = 400;
const CLIENT_ERROR_END = 500;
const REFUSAL_MAX_CHARS = 200;
const REFUSAL_MAX_BYTES = 4096;

/**
 * What the inviter said when it turned a join down. Only its own `error` text
 * of a 4xx answer, cut short, so the person sees why. A text that holds one of
 * our `secrets`, or any other part of the answer, stays out.
 */
const refusalOf = async (
  response: Response,
  secrets: readonly string[]
): Promise<string | null> => {
  if (
    response.status < CLIENT_ERROR_MIN ||
    response.status >= CLIENT_ERROR_END
  ) {
    return null;
  }
  const body: unknown = await readBounded(response, REFUSAL_MAX_BYTES)
    .then((raw) => JSON.parse(raw) as unknown)
    .catch(() => null);
  const text =
    typeof body === "object" && body !== null && "error" in body
      ? body.error
      : null;
  if (
    typeof text !== "string" ||
    text === "" ||
    secrets.some((secret) => text.includes(secret))
  ) {
    return null;
  }
  return text.slice(0, REFUSAL_MAX_CHARS);
};

export const createPairingTransport = (fetch: A2aFetch): PairingTransport => ({
  activate: async ({ bearer, token, url }) => {
    const response = await fetch(url, {
      body: JSON.stringify({ token }),
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${bearer}` },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(
        `Peer activation answered with status ${response.status}`
      );
    }
  },
  join: async ({ body, inviteToken, origin }) => {
    const response = await fetch(`${origin}/a2a/pair/join`, {
      body: JSON.stringify(body),
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${inviteToken}` },
      method: "POST",
    });
    if (!response.ok) {
      const refusal = await refusalOf(response, [inviteToken, body.token]);
      if (refusal !== null) {
        throw new ServiceError("invalid", `The inviter refused: ${refusal}`);
      }
      throw new Error(`Peer join answered with status ${response.status}`);
    }
    return parseJson(response, "join");
  },
});

export const createCardFetcher =
  (fetch: A2aFetch) =>
  async (url: string): Promise<unknown> => {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(`Agent card answered with status ${response.status}`);
    }
    const text = await readBounded(response, CARD_MAX_BYTES);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("The agent card is not JSON", { cause: error });
    }
  };
