/** What an agent asks `web_fetch` or `curl` to send. `method` defaults to GET. */
export interface WebFetchRequest {
  body?: Uint8Array;
  headers?: Record<string, string>;
  method?: string;
  url: string;
}

export type WebFetchFailure =
  | "bad_request"
  | "blocked"
  | "timeout"
  | "too_large"
  | "too_many_redirects"
  | "unreachable";

export type WebFetchResult =
  | {
      bytes: Uint8Array;
      durationMs: number;
      headers: Record<string, string>;
      ok: true;
      status: number;
      statusText: string;
      /** The URL the answer came from, after redirects. */
      url: string;
    }
  | { error: WebFetchFailure; message: string; ok: false };

export type WebFetcher = (request: WebFetchRequest) => Promise<WebFetchResult>;

/** Largest answer body, in bytes. */
export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024;

/** Wall-clock cap for one call, redirects included. */
export const WEB_FETCH_TIMEOUT_MS = 30_000;

export const WEB_FETCH_MAX_REDIRECTS = 5;

/** What `curl` and the tool say when the agent's setting is off. */
export const NETWORK_OFF_MESSAGE = "Network access is off for this agent.";
