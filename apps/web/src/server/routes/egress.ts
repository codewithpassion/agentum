// The explicit egress relay, `/api/egress/<host>/<path>`. Agents that cannot be
// intercepted (managed agents, machines) call it with their run token. The
// Worker adds the header that a workspace secret's rule names, and forwards the
// call to the host over HTTPS, so the secret never leaves the Worker. Per
// request, in this order: verify the token, find the rules the agent holds for
// the host (403 when there are none), run the SSRF guard, forward without
// following redirects, scrub the answer, and append one event that names the
// secret and the host. Mount with `accessRoutes.route("/api/egress", egressRoutes())`.

import { readCappedBody } from "@repo/app-gateway/body";
import type { Fetcher } from "@repo/services/connectors/mcp";
import { assertSafeUrl } from "@repo/services/connectors/url";
import type { RunTokenClaims } from "@repo/services/run-tokens";
import { importRunTokenKey, verifyAgentToken } from "@repo/services/run-tokens";
import type { ProxyMatch, SecretsService } from "@repo/services/secrets";
import { RELAY_PATH } from "@repo/services/secrets/relay";
import { normalizeHost } from "@repo/services/secrets/rules";
import { scrubBody, scrubText } from "@repo/services/secrets/scrub";
import type { Context } from "hono";
import { type AppEnv, bearerGroup } from "./groups.ts";
import { PROXY_CAP_MS } from "./proxy.ts";

/** Largest request or answer body the relay carries. */
export const MAX_EGRESS_BODY_BYTES = 10 * 1024 * 1024;

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const BAD_GATEWAY = 502;
const UNREACHABLE = 502;
const TIMEOUT = 504;
const RETRY_AFTER_SECONDS = "30";
const UNAVAILABLE = 503;
const METHOD_NOT_ALLOWED = 405;
const NO_BODY_STATUSES = new Set([204, 205, 304]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const METHODS = new Set(["GET", "HEAD", ...BODY_METHODS]);
const ALLOW = "GET, HEAD, POST, PUT, PATCH, DELETE";
const BEARER = /^Bearer\s+(.+)$/i;

/** Request headers the relay never sends upstream. `authorization` is the relay token. */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const DROPPED_REQUEST_PREFIXES = ["proxy-", "cf-", "x-forwarded-", "x-real-ip"];
const FORWARDED_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-disposition",
  "content-type",
  "etag",
  "last-modified",
  "location",
  "retry-after",
  "x-request-id",
]);
const RATELIMIT_PREFIX = "x-ratelimit-";

type LogEntry = Record<string, unknown>;
type RouteContext = Context<AppEnv>;

export interface EgressRouteOptions {
  /** Wall-clock cap on one relayed call. */
  capMs?: number;
  /** How calls reach the host. The global `fetch` by default. */
  fetch?: Fetcher;
  /** Structured log line. `console.log` of JSON by default (`wrangler tail`). */
  log?: (entry: LogEntry) => void;
}

const defaultLog = (entry: LogEntry) => {
  console.log(JSON.stringify(entry));
};

const unauthorized = (): Response =>
  Response.json(
    { error: "unauthorized" },
    {
      headers: { "WWW-Authenticate": 'Bearer realm="agentum"' },
      status: UNAUTHORIZED,
    }
  );

const unavailable = (): Response =>
  Response.json(
    { error: "temporarily_unavailable" },
    { headers: { "Retry-After": RETRY_AFTER_SECONDS }, status: UNAVAILABLE }
  );

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The host segment and the path after it, both as the client sent them. */
const splitTarget = (pathname: string): { host: string; path: string } => {
  const rest = pathname.slice(RELAY_PATH.length + 1);
  const slash = rest.indexOf("/");
  return slash === -1
    ? { host: rest, path: "/" }
    : { host: rest.slice(0, slash), path: rest.slice(slash) };
};

const isDroppedRequestHeader = (name: string): boolean =>
  DROPPED_REQUEST_HEADERS.has(name) ||
  DROPPED_REQUEST_PREFIXES.some((prefix) => name.startsWith(prefix));

const isForwardedResponseHeader = (name: string): boolean =>
  FORWARDED_RESPONSE_HEADERS.has(name) || name.startsWith(RATELIMIT_PREFIX);

/** The client's headers without the ones the relay owns, then each rule's header. Later rules win. */
const upstreamHeaders = (
  request: Request,
  matches: readonly ProxyMatch[]
): Headers => {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!isDroppedRequestHeader(name)) {
      headers.set(name, value);
    }
  }
  for (const match of matches) {
    headers.set(match.header, match.headerValue);
  }
  return headers;
};

/** The answer's headers that the agent may see, each value scrubbed of every secret. */
const relayedHeaders = (
  response: Response,
  matches: readonly ProxyMatch[]
): Headers => {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (isForwardedResponseHeader(name)) {
      headers.set(name, scrubText(value, matches));
    }
  }
  return headers;
};

type Exchange =
  | { body: Uint8Array<ArrayBuffer> | null; kind: "answer"; response: Response }
  | { kind: "timeout" | "unreachable" | "too_large" };

/** The answer to the agent for one exchange: the relayed answer, or the error the agent reads. */
const relayOutcome = (
  sent: Exchange,
  matches: readonly ProxyMatch[]
): Response => {
  switch (sent.kind) {
    case "answer":
      return answer(sent.response, sent.body, matches);
    case "timeout":
      return Response.json({ error: "upstream_timeout" }, { status: TIMEOUT });
    case "too_large":
      return Response.json(
        { error: "upstream_too_large" },
        { status: BAD_GATEWAY }
      );
    case "unreachable":
      return Response.json(
        { error: "upstream_unreachable" },
        { status: UNREACHABLE }
      );
    default:
      return unavailable();
  }
};

/** One call to the host, the answer read in full inside the cap. A failure is a result, not a throw. */
const exchange = async ({
  fetchImpl,
  init,
  url,
}: {
  fetchImpl: Fetcher;
  init: RequestInit;
  url: string;
}): Promise<Exchange> => {
  try {
    const response = await fetchImpl(url, init);
    if (init.method === "HEAD" || NO_BODY_STATUSES.has(response.status)) {
      return { body: null, kind: "answer", response };
    }
    // Empty headers: the declared length is not trusted, the bytes are counted.
    const read = await readCappedBody(
      { body: response.body, headers: new Headers() },
      MAX_EGRESS_BODY_BYTES
    );
    if (!read.ok) {
      return { kind: "too_large" };
    }
    return { body: read.bytes, kind: "answer", response };
  } catch (error: unknown) {
    const timedOut =
      error instanceof DOMException && error.name === "TimeoutError";
    return { kind: timedOut ? "timeout" : "unreachable" };
  }
};

const secretsOf = (c: RouteContext): SecretsService =>
  c.get("composed").services.secrets;

/** The answer to the agent: the scrubbed headers, and the body with every secret blanked. */
const answer = (
  response: Response,
  bytes: Uint8Array<ArrayBuffer> | null,
  matches: readonly ProxyMatch[]
): Response =>
  new Response(
    bytes === null
      ? null
      : scrubBody(bytes, response.headers.get("content-type"), matches),
    { headers: relayedHeaders(response, matches), status: response.status }
  );

export const egressRoutes = ({
  capMs = PROXY_CAP_MS,
  fetch: fetchImpl = (input, init) => fetch(input, init),
  log = defaultLog,
}: EgressRouteOptions = {}) => {
  const routes = bearerGroup();

  /** The run behind the token, null for a bad one. Throws when auth cannot run. */
  const authenticate = async (
    c: RouteContext
  ): Promise<RunTokenClaims | null> => {
    const token = BEARER.exec(c.req.header("Authorization") ?? "")?.[1];
    if (!token) {
      return null;
    }
    const { clock, db } = c.get("composed");
    const result = await verifyAgentToken({
      db,
      key: await importRunTokenKey(c.env.RUN_TOKEN_KEY),
      now: clock.now(),
      token,
    });
    return result.ok && !result.scopeArtifactId ? result.claims : null;
  };

  const denied = (
    claims: RunTokenClaims,
    host: string,
    reason: "host_not_allowed" | "host_not_granted"
  ): Response => {
    log({ event: "egress.denied", host, reason, runId: claims.runId });
    return Response.json(
      reason === "host_not_granted"
        ? { error: reason, host }
        : { error: reason },
      { status: FORBIDDEN }
    );
  };

  /** One event for the call. A failure to record it must not undo the call. */
  const announce = async (
    claims: RunTokenClaims,
    matches: readonly ProxyMatch[],
    host: string,
    secrets: SecretsService
  ): Promise<void> => {
    try {
      await secrets.announceInjection(
        {
          agentId: claims.agentId,
          runId: claims.runId,
          workspaceId: claims.workspaceId,
        },
        {
          host,
          names: [...new Set(matches.map((match) => match.name))],
          via: "relay",
        }
      );
    } catch (error: unknown) {
      log({
        event: "egress.event_failed",
        message: errorMessage(error),
        runId: claims.runId,
      });
    }
  };

  /** Everything after the token: the grant, the guard, the call, the answer. */
  const forward = async (
    c: RouteContext,
    claims: RunTokenClaims
  ): Promise<Response> => {
    const { pathname, search } = new URL(c.req.url);
    const target = splitTarget(pathname);
    const host = normalizeHost(target.host);
    const secrets = secretsOf(c);
    const matches = await secrets.proxyFor(
      claims.workspaceId,
      claims.agentId,
      host
    );
    if (matches.length === 0) {
      return denied(claims, host, "host_not_granted");
    }
    let url: string;
    try {
      const safe = assertSafeUrl(`https://${host}${target.path}${search}`);
      // The credential goes to the host the rule matched, whatever else the segment held.
      if (safe.hostname !== host) {
        return denied(claims, host, "host_not_allowed");
      }
      url = safe.toString();
    } catch {
      return denied(claims, host, "host_not_allowed");
    }

    const { method } = c.req.raw;
    if (!METHODS.has(method)) {
      return new Response(null, {
        headers: { Allow: ALLOW },
        status: METHOD_NOT_ALLOWED,
      });
    }
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (BODY_METHODS.has(method)) {
      const read = await readCappedBody(c.req.raw, MAX_EGRESS_BODY_BYTES);
      if (!read.ok) {
        return Response.json({ error: read.error }, { status: read.status });
      }
      body = read.bytes;
    }

    await c
      .get("composed")
      .services.requests.requireOutbound(
        { ...claims, kind: "run" },
        "network/egress",
        {
          method,
          url,
          headers: Object.fromEntries(upstreamHeaders(c.req.raw, matches)),
          body: body ? [...body] : [],
        }
      );
    const sent = await exchange({
      fetchImpl,
      init: {
        body,
        headers: upstreamHeaders(c.req.raw, matches),
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(capMs),
      },
      url,
    });
    // The credential went out on the request, whatever the host answered.
    await announce(claims, matches, host, secrets);

    return relayOutcome(sent, matches);
  };

  const handle = async (c: RouteContext): Promise<Response> => {
    let claims: RunTokenClaims | null;
    try {
      claims = await authenticate(c);
    } catch (error: unknown) {
      log({
        event: "egress.error",
        message: errorMessage(error),
        phase: "authenticate",
      });
      return unavailable();
    }
    if (!claims) {
      return unauthorized();
    }
    try {
      return await forward(c, claims);
    } catch (error: unknown) {
      log({
        event: "egress.error",
        message: errorMessage(error),
        phase: "forward",
        runId: claims.runId,
      });
      return unavailable();
    }
  };

  routes.all("/:host", handle);
  routes.all("/:host/*", handle);

  return routes;
};
