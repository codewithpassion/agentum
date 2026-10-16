const SLACK_API = "https://slack.com/api";
const API_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 900;

/** Slack errors that mean the app or channel setup is wrong. */
const CONFIG_ERRORS = new Set([
  "account_inactive",
  "channel_not_found",
  "invalid_auth",
  "is_archived",
  "not_authed",
  "not_in_channel",
  "token_revoked",
]);

export type SlackFetch = (url: string, init: RequestInit) => Promise<Response>;

export type SlackCallResult<T extends object = Record<never, never>> =
  | ({ kind: "ok" } & T)
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "config"; error: string }
  | { kind: "transient"; error: string }
  | { kind: "rejected"; error: string };

export type SlackDownload =
  | { bytes: Uint8Array<ArrayBuffer>; contentType: string | null; kind: "ok" }
  | { kind: "too_large" }
  | { error: string; kind: "rejected" | "transient" };

export interface SlackClient {
  downloadFile: (url: string, maxBytes: number) => Promise<SlackDownload>;
  postEphemeral: (request: {
    channel: string;
    text: string;
    threadTs?: string;
    user: string;
  }) => Promise<SlackCallResult>;
  postMessage: (request: {
    channel: string;
    text: string;
    threadTs?: string;
  }) => Promise<SlackCallResult<{ ts: string }>>;
  userEmail: (
    userId: string
  ) => Promise<SlackCallResult<{ email: string | null }>>;
}

type Body = Record<string, unknown>;

interface Endpoint {
  body?: Body;
  method: "GET" | "POST";
  url: URL;
}

function apiUrl(method: string, query: Record<string, string> = {}): URL {
  const url = new URL(`${SLACK_API}/${method}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function asBody(value: unknown): Body {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Body)
    : {};
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "network_error";
}

function retryAfter(response: Response): number {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_SECONDS)
    : DEFAULT_RATE_LIMIT_SECONDS;
}

/**
 * `&`, `<` and `>` are the only characters Slack reads as control syntax, so
 * escaping them leaves no way to write a mention (`<!channel>`, `<@U123>`), a
 * channel link or a masked link (`<https://evil|label>`) in text an agent
 * wrote.
 */
function escapeSlack(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function classify<T extends object>(
  body: Body,
  response: Response,
  read: (body: Body) => T | null
): SlackCallResult<T> {
  if (body.ok === true) {
    const value = read(body);
    if (value !== null) {
      return { kind: "ok", ...value };
    }
    return { error: "no_error", kind: "rejected" };
  }
  const error = typeof body.error === "string" ? body.error : "no_error";
  if (error === "ratelimited") {
    return { kind: "rate_limited", retryAfterSeconds: retryAfter(response) };
  }
  if (CONFIG_ERRORS.has(error)) {
    return { error, kind: "config" };
  }
  return { error, kind: "rejected" };
}

function isSlackFileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  return (
    parsed.protocol === "https:" &&
    (host === "files.slack.com" || host.endsWith(".slack-files.com"))
  );
}

/** Reads the body up to maxBytes. The cap is enforced per chunk, before buffering. */
async function readCapped(
  response: Response,
  maxBytes: number
): Promise<SlackDownload> {
  const contentType = response.headers.get("content-type");
  const { body } = response;
  if (body === null) {
    return { bytes: new Uint8Array(0), contentType, kind: "ok" };
  }
  let total = 0;
  const cap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new RangeError("slack download over cap"));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  try {
    const buffer = await new Response(body.pipeThrough(cap)).arrayBuffer();
    return { bytes: new Uint8Array(buffer), contentType, kind: "ok" };
  } catch (error) {
    if (total > maxBytes) {
      return { kind: "too_large" };
    }
    return { error: errorName(error), kind: "transient" };
  }
}

export const createSlackClient = (deps: {
  fetch: SlackFetch;
  token: string;
}): SlackClient => {
  /** Calls one Slack Web API method. Never throws, and never puts the token in a result. */
  async function callSlack<T extends object>(
    endpoint: Endpoint,
    read: (body: Body) => T | null
  ): Promise<SlackCallResult<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${deps.token}`,
    };
    let body: string | undefined;
    if (endpoint.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(endpoint.body);
    }
    let response: Response;
    try {
      response = await deps.fetch(endpoint.url.href, {
        body,
        headers,
        method: endpoint.method,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      return { error: errorName(error), kind: "transient" };
    }
    if (response.status === 429) {
      return { kind: "rate_limited", retryAfterSeconds: retryAfter(response) };
    }
    if (response.status >= 500) {
      return { error: `http_${response.status}`, kind: "transient" };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return {
        error: `http_${response.status}_bad_body`,
        kind: "transient",
      };
    }
    return classify(asBody(parsed), response, read);
  }

  return {
    async downloadFile(url, maxBytes) {
      if (!isSlackFileUrl(url)) {
        return { error: "bad_host", kind: "rejected" };
      }
      let response: Response;
      try {
        response = await deps.fetch(url, {
          headers: { Authorization: `Bearer ${deps.token}` },
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (error) {
        return { error: errorName(error), kind: "transient" };
      }
      if (response.status === 429 || response.status >= 500) {
        return { error: `http_${response.status}`, kind: "transient" };
      }
      if (!response.ok) {
        return { error: `http_${response.status}`, kind: "rejected" };
      }
      const declared = response.headers.get("content-length");
      if (declared !== null && Number(declared) > maxBytes) {
        return { kind: "too_large" };
      }
      const contentType = response.headers.get("content-type");
      if (contentType?.toLowerCase().startsWith("text/html")) {
        return { error: "html_response", kind: "rejected" };
      }
      return readCapped(response, maxBytes);
    },

    postEphemeral(request) {
      return callSlack(
        {
          body: {
            channel: request.channel,
            text: escapeSlack(request.text),
            thread_ts: request.threadTs,
            user: request.user,
          },
          method: "POST",
          url: apiUrl("chat.postEphemeral"),
        },
        () => ({})
      );
    },

    postMessage(request) {
      return callSlack(
        {
          body: {
            channel: request.channel,
            text: escapeSlack(request.text),
            thread_ts: request.threadTs,
            unfurl_links: false,
            unfurl_media: false,
          },
          method: "POST",
          url: apiUrl("chat.postMessage"),
        },
        (body) => {
          const { ts } = body;
          return typeof ts === "string" ? { ts } : null;
        }
      );
    },

    userEmail(userId) {
      return callSlack(
        { method: "GET", url: apiUrl("users.info", { user: userId }) },
        (body) => {
          const profile = asBody(asBody(body.user).profile);
          const { email } = profile;
          return {
            email: typeof email === "string" && email !== "" ? email : null,
          };
        }
      );
    },
  };
};
