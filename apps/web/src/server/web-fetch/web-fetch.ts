// The one fetcher behind the agent's `web_fetch` tool and `curl`. Each call
// follows redirects by hand, so every hop passes the SSRF guard, and every hop
// goes through `outboundFetch`, which is the only place a credential header is
// added. A caller's own `authorization` and `cookie` are dropped as soon as a
// redirect leaves the host they were sent to. Each hop that is sent, and each
// target that is refused, writes one network entry. The entry holds the host
// name and numbers only.

import type { NetworkRequestEntry } from "@repo/services/network";
import { readCappedBody } from "../mcp/body.ts";
import { type OutboundDeps, outboundFetch } from "../secrets-outbound-core.ts";
import { checkTarget, redirectTarget } from "./guard.ts";
import {
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_TIMEOUT_MS,
  type WebFetcher,
  type WebFetchFailure,
  type WebFetchResult,
} from "./types.ts";

export interface WebFetchDeps {
  announce: OutboundDeps["announce"];
  /** Sends one request, redirects not followed. The global fetch in the app, a fake in tests. */
  fetch: OutboundDeps["fetch"];
  log: OutboundDeps["log"];
  matches: OutboundDeps["matches"];
  maxBytes?: number;
  maxRedirects?: number;
  now?: () => number;
  ownHosts: readonly string[];
  /** Writes the Log event. May reject: the call goes on. */
  record: (entry: NetworkRequestEntry) => Promise<void>;
  timeoutMs?: number;
  via: NetworkRequestEntry["via"];
}

const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Answers that carry no body, whatever the headers say. */
const BODYLESS_STATUSES = new Set([204, 205, 304]);
/** Headers the caller may not set: the runtime owns them, or they belong to a hop. */
const DROPPED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-real-ip",
]);
const DROPPED_REQUEST_PREFIXES = ["cf-", "proxy-", "x-forwarded-"];
/** Credentials a caller sends for its own origin. They never follow a redirect to another origin. */
const CROSS_HOST_DROPPED_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
];
const TRAILING_PERIOD = /\.$/;
const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
];
const MESSAGES: Record<WebFetchFailure, string> = {
  bad_request: "The request is not valid.",
  blocked: "The request was refused.",
  timeout: "The request timed out.",
  too_large: "The answer is larger than the limit.",
  too_many_redirects: "The request followed too many redirects.",
  unreachable: "The host could not be reached.",
};

/** One request as it is sent: a hop of the call. */
interface Hop {
  body: Uint8Array<ArrayBuffer> | undefined;
  headers: Headers;
  method: string;
  url: URL;
}

/** What one call shares across its hops. */
interface Call {
  deps: WebFetchDeps;
  maxBytes: number;
  maxRedirects: number;
  now: () => number;
  signal: AbortSignal;
  started: number;
}

interface Failed {
  error: WebFetchFailure;
  message: string;
  ok: false;
}

const failed = (error: WebFetchFailure, message = MESSAGES[error]): Failed => ({
  error,
  message,
  ok: false,
});

/** "The request was refused: <reason>." with one full stop, whether or not the reason ends in one. */
const refusal = (what: string, reason: string): string =>
  `${what} was refused: ${reason.replace(TRAILING_PERIOD, "")}.`;

const isDroppedRequestHeader = (name: string): boolean =>
  DROPPED_REQUEST_HEADERS.has(name) ||
  DROPPED_REQUEST_PREFIXES.some((prefix) => name.startsWith(prefix));

/** The caller's headers that may be sent. A bad name or value throws a TypeError. */
const requestHeadersOf = (
  headers: Record<string, string> | undefined
): Headers => {
  const sent = new Headers();
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (!isDroppedRequestHeader(lower)) {
      sent.set(lower, value);
    }
  }
  return sent;
};

/** The answer's headers, lower-case names. Repeated names are joined, as HTTP joins them. */
const responseHeadersOf = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = name in out ? `${out[name]}, ${value}` : value;
  });
  return out;
};

const withoutCredentials = (headers: Headers): Headers => {
  const copy = new Headers(headers);
  for (const name of CROSS_HOST_DROPPED_HEADERS) {
    copy.delete(name);
  }
  return copy;
};

/** The host name a URL string names, for the log. `invalid` when it names none. */
const hostOf = (raw: string, base?: URL): string => {
  try {
    return new URL(raw, base).hostname || "invalid";
  } catch {
    return "invalid";
  }
};

/** The method the next hop sends. A redirect that turns a POST into a GET says so here. */
const methodAfterRedirect = (status: number, method: string): string => {
  if (method === "HEAD") {
    return method;
  }
  const becomesGet =
    status === 303 || ((status === 301 || status === 302) && method === "POST");
  return becomesGet ? "GET" : method;
};

/** The Location of a redirect that the call follows, or null when the answer is final. */
const followableLocation = (response: Response): string | null => {
  const location = response.headers.get("location");
  if (
    !REDIRECT_STATUSES.has(response.status) ||
    location === null ||
    location.trim() === ""
  ) {
    return null;
  }
  return location;
};

const discard = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};

const record = async (
  call: Call,
  entry: NetworkRequestEntry
): Promise<void> => {
  try {
    await call.deps.record(entry);
  } catch {
    call.deps.log("web fetch: recording the request failed");
  }
};

const entryOf = (call: Call, hop: Hop) => ({
  host: hop.url.hostname,
  method: hop.method,
  via: call.deps.via,
});

const recordRefused = (
  call: Call,
  host: string,
  method: string,
  reason: string
): Promise<void> =>
  record(call, {
    blocked: reason,
    bytes: 0,
    durationMs: 0,
    host,
    method,
    status: null,
    via: call.deps.via,
  });

/** A call that ended without an answer: the caller's abort or the deadline, or any other error. */
const transportError = (call: Call): WebFetchFailure =>
  call.signal.aborted ? "timeout" : "unreachable";

/** Sends one hop through `outboundFetch`, the one place a credential header is added. */
const sendHop = (call: Call, hop: Hop): Promise<Response> =>
  outboundFetch(
    new Request(hop.url.href, {
      body: hop.body,
      headers: hop.headers,
      method: hop.method,
      redirect: "manual",
      signal: call.signal,
    }),
    call.deps
  );

type Read =
  | { bytes: Uint8Array; ok: true }
  | { error: WebFetchFailure; ok: false };

const readAnswer = async (
  call: Call,
  hop: Hop,
  response: Response
): Promise<Read> => {
  if (hop.method === "HEAD" || BODYLESS_STATUSES.has(response.status)) {
    await discard(response);
    return { bytes: new Uint8Array(), ok: true };
  }
  try {
    const read = await readCappedBody(
      { body: response.body, headers: new Headers() },
      call.maxBytes
    );
    return read.ok
      ? { bytes: read.bytes, ok: true }
      : { error: "too_large", ok: false };
  } catch {
    return { error: transportError(call), ok: false };
  }
};

const answer = async (
  call: Call,
  hop: Hop,
  response: Response,
  sentAt: number
): Promise<WebFetchResult> => {
  const read = await readAnswer(call, hop, response);
  // A read cut short by the deadline is a timeout, so its status is unknown.
  const status = read.ok || read.error === "too_large" ? response.status : null;
  await record(call, {
    ...entryOf(call, hop),
    bytes: read.ok ? read.bytes.byteLength : 0,
    durationMs: call.now() - sentAt,
    status,
  });
  if (!read.ok) {
    return failed(read.error);
  }
  return {
    bytes: read.bytes,
    durationMs: call.now() - call.started,
    headers: responseHeadersOf(response.headers),
    ok: true,
    status: response.status,
    statusText: response.statusText,
    url: hop.url.href,
  };
};

const follow = async (
  call: Call,
  hop: Hop,
  status: number,
  location: string,
  redirects: number
): Promise<WebFetchResult> => {
  const method = methodAfterRedirect(status, hop.method);
  const next = redirectTarget(hop.url, location, call.deps.ownHosts);
  if (!next.ok) {
    await recordRefused(call, hostOf(location, hop.url), method, next.reason);
    return failed("blocked", refusal("The redirect", next.reason));
  }
  // The whole origin, not the host: a hop from https to http, or to another
  // port, must not carry the caller's token either.
  const sameOrigin = next.url.origin === hop.url.origin;
  const bodyKept = method === hop.method;
  const headers = sameOrigin
    ? new Headers(hop.headers)
    : withoutCredentials(hop.headers);
  if (!bodyKept) {
    // The headers that describe the body go with it, as a browser does.
    for (const name of BODY_HEADERS) {
      headers.delete(name);
    }
  }
  return runHop(
    call,
    {
      // A body goes only where the method stays the same.
      body: bodyKept ? hop.body : undefined,
      headers,
      method,
      url: next.url,
    },
    redirects + 1
  );
};

/** Sends one hop, then answers, follows its redirect, or fails. */
const runHop = async (
  call: Call,
  hop: Hop,
  redirects: number
): Promise<WebFetchResult> => {
  const sentAt = call.now();
  let response: Response;
  try {
    response = await sendHop(call, hop);
  } catch {
    await record(call, {
      ...entryOf(call, hop),
      bytes: 0,
      durationMs: call.now() - sentAt,
      status: null,
    });
    return failed(transportError(call));
  }
  const location = followableLocation(response);
  if (location === null) {
    return answer(call, hop, response, sentAt);
  }
  await record(call, {
    ...entryOf(call, hop),
    bytes: 0,
    durationMs: call.now() - sentAt,
    status: response.status,
  });
  await discard(response);
  if (redirects === call.maxRedirects) {
    return failed("too_many_redirects");
  }
  return follow(call, hop, response.status, location, redirects);
};

/** Why a request is not valid, or undefined when it is. */
const invalidReason = (
  method: string,
  body: Uint8Array | undefined
): string | undefined => {
  if (!METHODS.has(method)) {
    return "The method is not one of GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS.";
  }
  if (body !== undefined && BODYLESS_METHODS.has(method)) {
    return "GET and HEAD requests cannot have a body.";
  }
};

export const createWebFetcher = (deps: WebFetchDeps): WebFetcher => {
  const maxBytes = deps.maxBytes ?? WEB_FETCH_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? WEB_FETCH_MAX_REDIRECTS;
  const timeoutMs = deps.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  return async (request): Promise<WebFetchResult> => {
    const started = now();
    const method =
      request.method === undefined ? "GET" : request.method.toUpperCase();
    const reason = invalidReason(method, request.body);
    if (reason !== undefined) {
      return failed("bad_request", reason);
    }
    let headers: Headers;
    try {
      headers = requestHeadersOf(request.headers);
    } catch {
      return failed("bad_request", "A header name or value is not valid.");
    }

    // One deadline for the whole call, redirects included.
    const timer = AbortSignal.timeout(timeoutMs);
    const call: Call = {
      deps,
      maxBytes,
      maxRedirects,
      now,
      signal: request.signal ? AbortSignal.any([timer, request.signal]) : timer,
      started,
    };

    const first = checkTarget(request.url, deps.ownHosts);
    if (!first.ok) {
      await recordRefused(call, hostOf(request.url), method, first.reason);
      return failed("blocked", refusal("The request", first.reason));
    }
    return runHop(
      call,
      {
        // A copy with a plain ArrayBuffer, which the Request body type needs.
        body:
          request.body === undefined ? undefined : new Uint8Array(request.body),
        headers,
        method,
        url: first.url,
      },
      0
    );
  };
};
