// The A2A server, mounted at `/a2a` with `mountA2aRoutes`. Per published agent
// (`/a2a/<publicId>`) it serves the agent card, the JSON-RPC binding (`/rpc`),
// the HTTP+JSON binding (`/rest/...`) and the pairing calls of two
// Harbourmaster deployments. Thin, like `triggers.ts`: read a capped body,
// authenticate, call a service, word the answer. The rules live in
// `@repo/services/a2a/*`, and the operations in `a2a-ops.ts`, shared by both
// bindings. The spec is docs/v3/agent-connections.md ("A2A mapping").

import { buildAgentCard } from "@repo/a2a/agent-card";
import {
  type ErrorName,
  errorStatus,
  jsonRpcError,
  restErrorBody,
} from "@repo/a2a/errors";
import {
  buildJsonRpcErrorResponse,
  buildJsonRpcResult,
  type JsonRpcId,
  type JsonRpcMethod,
  parseJsonRpcRequest,
} from "@repo/a2a/jsonrpc";
import {
  A2A_MEDIA_TYPE,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
} from "@repo/a2a/protocol";
import { matchRestRoute } from "@repo/a2a/rest";
import type { StreamResponse } from "@repo/a2a/tasks";
import type {
  PairActivateBody,
  PairJoinBody,
} from "@repo/services/a2a/connections";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { readCappedBody } from "../mcp/body.ts";
import {
  classify,
  RATE_LIMITED_MESSAGE,
  type Refusal,
  UNAUTHORIZED_MESSAGE,
} from "./a2a-errors.ts";
import {
  type A2aTiming,
  DEFAULT_TIMING,
  type OperationOutcome,
  runOperation,
} from "./a2a-ops.ts";
import { type AppEnv, bearerGroup } from "./groups.ts";

type RouteContext = Context<AppEnv>;

const MAX_BODY_BYTES = 256 * 1024;
const WWW_AUTHENTICATE = 'Bearer realm="harbourmaster"';
const BEARER = /^Bearer\s+(\S+)$/i;
const CARD_MAX_AGE_SECONDS = 300;
const ETAG_LENGTH = 32;
const HEX = 16;
/** The JSON-RPC code for what the A2A spec has no name for: a missing credential and the hourly limit. */
const SERVER_ERROR_CODE = -32_000;
const UNAUTHORIZED = 401;
const RATE_LIMITED = 429;

export interface A2aRoutesOptions {
  timing?: Partial<A2aTiming>;
}

// ---------------------------------------------------------------------------
// Words, per binding

/** How one binding words a result and a refusal. */
interface Binding {
  contentType: string;
  errorBody: (refusal: Refusal) => unknown;
  errorStatus: (name: ErrorName) => number;
  resultBody: (result: unknown) => unknown;
}

const plainError = (refusal: Exclude<Refusal, { kind: "error" }>) =>
  refusal.kind === "unauthorized"
    ? {
        code: UNAUTHORIZED,
        message: UNAUTHORIZED_MESSAGE,
        status: "UNAUTHENTICATED",
      }
    : {
        code: RATE_LIMITED,
        message: RATE_LIMITED_MESSAGE,
        status: "RESOURCE_EXHAUSTED",
      };

const jsonRpcBinding = (id: JsonRpcId | null): Binding => ({
  contentType: "application/json",
  errorBody: (refusal) =>
    buildJsonRpcErrorResponse(
      id,
      refusal.kind === "error"
        ? jsonRpcError(refusal.name, refusal.options)
        : {
            code: SERVER_ERROR_CODE,
            message: plainError(refusal).message,
          }
    ),
  // A JSON-RPC error is an answer, so the request itself succeeded.
  errorStatus: () => 200,
  resultBody: (result) => buildJsonRpcResult(id, result),
});

const restBinding: Binding = {
  contentType: A2A_MEDIA_TYPE,
  errorBody: (refusal) =>
    refusal.kind === "error"
      ? restErrorBody(refusal.name, refusal.options)
      : { error: { ...plainError(refusal), details: [] } },
  errorStatus,
  resultBody: (result) => result,
};

const send = (
  binding: Binding,
  body: unknown,
  status: number,
  headers: Record<string, string> = {}
): Response =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": binding.contentType, ...headers },
    status,
  });

const failure = (binding: Binding, refusal: Refusal): Response => {
  const body = binding.errorBody(refusal);
  switch (refusal.kind) {
    case "unauthorized":
      return send(binding, body, UNAUTHORIZED, {
        "WWW-Authenticate": WWW_AUTHENTICATE,
      });
    case "rate_limited":
      return send(binding, body, RATE_LIMITED, {
        "Retry-After": String(refusal.retryAfterSeconds),
      });
    default:
      return send(binding, body, binding.errorStatus(refusal.name));
  }
};

const invalid = (name: ErrorName, message?: string): Refusal => ({
  kind: "error",
  name,
  options: message === undefined ? {} : { message },
});

/** The `text/event-stream` of a run of events, each framed by the binding. */
const eventStream = (
  binding: Binding,
  events: AsyncIterable<StreamResponse>,
  signal: AbortSignal
): Response => {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  const stopped = new AbortController();
  signal.addEventListener("abort", () => stopped.abort(), { once: true });
  const frame = (body: unknown) =>
    encoder.encode(`data: ${JSON.stringify(body)}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    cancel: async () => {
      stopped.abort();
      await iterator.return?.();
    },
    pull: async (controller) => {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(frame(binding.resultBody(next.value)));
      } catch (error) {
        controller.enqueue(frame(binding.errorBody(classify(error))));
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
};

// ---------------------------------------------------------------------------
// What every `/a2a/<publicId>` request goes through

const bearerOf = (c: RouteContext): string | null =>
  BEARER.exec(c.req.header("Authorization") ?? "")?.[1] ?? null;

/** The peer this token is, for this agent's path. Null for every way of not being one. */
const authenticate = async (c: RouteContext) => {
  const token = bearerOf(c);
  return token === null
    ? null
    : await c
        .get("composed")
        .services.connections.authenticate(
          token,
          c.req.param("publicId") ?? ""
        );
};

/** A missing header means 0.3, which we do not speak. */
const versionRefusal = (c: RouteContext): Refusal | null =>
  c.req.header(A2A_VERSION_HEADER)?.trim() === A2A_PROTOCOL_VERSION
    ? null
    : invalid(
        "VersionNotSupportedError",
        `This server speaks A2A ${A2A_PROTOCOL_VERSION}. Send ${A2A_VERSION_HEADER}: ${A2A_PROTOCOL_VERSION}.`
      );

const respond = (
  c: RouteContext,
  binding: Binding,
  outcome: OperationOutcome
): Response =>
  outcome.kind === "stream"
    ? eventStream(binding, outcome.events, c.req.raw.signal)
    : send(binding, binding.resultBody(outcome.body), 200);

const execute = async (
  c: RouteContext,
  binding: Binding,
  peer: NonNullable<Awaited<ReturnType<typeof authenticate>>>,
  operation: JsonRpcMethod,
  params: unknown,
  timing: A2aTiming
): Promise<Response> => {
  try {
    return respond(
      c,
      binding,
      await runOperation(operation, params, {
        peer,
        signal: c.req.raw.signal,
        tasks: c.get("composed").services.a2aTasks,
        timing,
      })
    );
  } catch (error) {
    return failure(binding, classify(error));
  }
};

// ---------------------------------------------------------------------------
// HTTP+JSON requests

const NUMERIC_QUERY = new Set(["historyLength", "pageSize"]);
const BOOLEAN_QUERY = new Set(["includeArtifacts"]);

/** Query values are text. A number or a boolean that does not read as one stays text, and the service refuses it. */
const queryParams = (url: URL): Record<string, unknown> => {
  const params: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (
      NUMERIC_QUERY.has(key) &&
      value.trim() !== "" &&
      !Number.isNaN(Number(value))
    ) {
      params[key] = Number(value);
    } else if (
      BOOLEAN_QUERY.has(key) &&
      (value === "true" || value === "false")
    ) {
      params[key] = value === "true";
    } else {
      params[key] = value;
    }
  }
  return params;
};

/** The body of an HTTP+JSON request: an object, `{}` when there is none. */
const readRestBody = async (
  c: RouteContext
): Promise<{ body: unknown; ok: true } | { ok: false; refusal: Refusal }> => {
  const read = await readCappedBody(c.req.raw, MAX_BODY_BYTES);
  if (!read.ok) {
    return { ok: false, refusal: invalid("InvalidRequestError", read.error) };
  }
  const text = new TextDecoder().decode(read.bytes).trim();
  if (text === "") {
    return { body: {}, ok: true };
  }
  try {
    return { body: JSON.parse(text), ok: true };
  } catch {
    return { ok: false, refusal: invalid("JSONParseError") };
  }
};

/** The parameters an operation takes, from where the HTTP+JSON binding puts them. */
const restParams = (
  operation: JsonRpcMethod,
  path: Record<string, string>,
  query: Record<string, unknown>,
  body: unknown
): unknown => {
  switch (operation) {
    case "SendMessage":
    case "SendStreamingMessage":
      return body;
    case "CreateTaskPushNotificationConfig":
      return {
        ...z.record(z.string(), z.unknown()).catch({}).parse(body),
        ...path,
      };
    case "GetTask":
      return { ...query, ...path };
    case "ListTasks":
      return query;
    default:
      return path;
  }
};

const restRequest = async (
  c: RouteContext,
  timing: A2aTiming
): Promise<Response> => {
  const peer = await authenticate(c);
  if (!peer) {
    return failure(restBinding, { kind: "unauthorized" });
  }
  const refusal = versionRefusal(c);
  if (refusal) {
    return failure(restBinding, refusal);
  }
  const url = new URL(c.req.url);
  // The public id is random text and may itself contain "rest".
  const marker = `/${c.req.param("publicId")}/rest`;
  const rest = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  const match = matchRestRoute(c.req.method, rest);
  if (!match) {
    return failure(restBinding, invalid("MethodNotFoundError"));
  }
  const { operation } = match.route;
  let body: unknown = {};
  if (c.req.method === "POST") {
    const read = await readRestBody(c);
    if (!read.ok) {
      return failure(restBinding, read.refusal);
    }
    ({ body } = read);
  }
  return await execute(
    c,
    restBinding,
    peer,
    operation,
    restParams(operation, match.params, queryParams(url), body),
    timing
  );
};

// ---------------------------------------------------------------------------
// JSON-RPC requests

const rpcRequest = async (
  c: RouteContext,
  timing: A2aTiming
): Promise<Response> => {
  const peer = await authenticate(c);
  if (!peer) {
    return failure(jsonRpcBinding(null), { kind: "unauthorized" });
  }
  const read = await readCappedBody(c.req.raw, MAX_BODY_BYTES);
  if (!read.ok) {
    return failure(
      jsonRpcBinding(null),
      invalid("InvalidRequestError", read.error)
    );
  }
  const parsed = parseJsonRpcRequest(new TextDecoder().decode(read.bytes));
  if (!parsed.ok) {
    return send(jsonRpcBinding(null), parsed.response, 200);
  }
  const binding = jsonRpcBinding(parsed.id);
  const refusal = versionRefusal(c);
  if (refusal) {
    return failure(binding, refusal);
  }
  return await execute(c, binding, peer, parsed.method, parsed.params, timing);
};

// ---------------------------------------------------------------------------
// The card

const digest = async (text: string): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(HEX).padStart(2, "0"))
    .join("")
    .slice(0, ETAG_LENGTH);
};

const cardRequest = async (c: RouteContext): Promise<Response> => {
  const publicId = c.req.param("publicId") ?? "";
  const found = await c
    .get("composed")
    .services.connections.publicCard(publicId);
  if (!found) {
    return c.json({ error: "Not found." }, 404, {
      "Cache-Control": "no-store",
    });
  }
  const baseUrl =
    (c.env as Partial<Env> | undefined)?.PUBLIC_BASE_URL ||
    new URL(c.req.url).origin;
  const text = JSON.stringify(
    buildAgentCard({
      agentName: found.agentName,
      baseUrl,
      description: found.description,
      publicId: found.publicId,
      skills: found.skills,
    })
  );
  const etag = `"${await digest(text)}"`;
  const headers = {
    "Cache-Control": `public, max-age=${CARD_MAX_AGE_SECONDS}`,
    ETag: etag,
  };
  if (c.req.header("If-None-Match") === etag) {
    return new Response(null, { headers, status: 304 });
  }
  return new Response(text, {
    headers: { ...headers, "Content-Type": "application/json" },
    status: 200,
  });
};

// ---------------------------------------------------------------------------
// Pairing. Plain JSON, not A2A: one Harbourmaster calling another.

const pairError = (c: RouteContext, error: unknown): Response => {
  if (isForbiddenError(error)) {
    return c.json({ error: "Not allowed." }, 403);
  }
  if (isServiceError(error)) {
    return c.json(
      { error: error.message },
      error.status as ContentfulStatusCode
    );
  }
  if (error instanceof z.ZodError) {
    const [issue] = error.issues;
    return c.json(
      {
        error: issue
          ? `${issue.path.join(".")}: ${issue.message}`
          : "The body is not valid.",
      },
      400
    );
  }
  throw error;
};

/**
 * A pairing call: the bearer is the credential. A body that is not JSON goes
 * to the service as `undefined`, which refuses it after it has looked at the
 * credential, so a wrong credential never learns anything about the body.
 */
const pairRequest = async (
  c: RouteContext,
  call: (
    token: string,
    body: unknown,
    publicId: string | undefined
  ) => Promise<unknown>
): Promise<Response> => {
  const token = bearerOf(c);
  if (token === null) {
    return c.json({ error: UNAUTHORIZED_MESSAGE }, UNAUTHORIZED, {
      "WWW-Authenticate": WWW_AUTHENTICATE,
    });
  }
  const read = await readCappedBody(c.req.raw, MAX_BODY_BYTES);
  if (!read.ok) {
    return c.json({ error: read.error }, read.status);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(read.bytes));
  } catch {
    body = undefined;
  }
  try {
    return c.json(
      (await call(token, body, c.req.param("publicId"))) ?? { ok: true }
    );
  } catch (error) {
    return pairError(c, error);
  }
};

// ---------------------------------------------------------------------------

export const a2aRoutes = (options: A2aRoutesOptions = {}): Hono<AppEnv> => {
  const routes = bearerGroup();
  const timing = { ...DEFAULT_TIMING, ...options.timing };
  const connections = (c: RouteContext) =>
    c.get("composed").services.connections;

  routes.use("*", async (c, next) => {
    await next();
    c.res.headers.set(A2A_VERSION_HEADER, A2A_PROTOCOL_VERSION);
  });

  routes.get("/:publicId/.well-known/agent-card.json", cardRequest);
  routes.post("/:publicId/rpc", (c) => rpcRequest(c, timing));
  routes.all("/:publicId/rest/*", (c) => restRequest(c, timing));

  routes.post("/pair/join", (c) =>
    pairRequest(c, (token, body) =>
      connections(c).join(token, body as PairJoinBody)
    )
  );
  routes.post("/:publicId/pair/activate", (c) =>
    pairRequest(c, async (token, body, publicId) => {
      await connections(c).activate(token, body as PairActivateBody, publicId);
    })
  );
  routes.post("/:publicId/pair/decline", (c) =>
    pairRequest(c, async (token, _body, publicId) => {
      await connections(c).declined(token, publicId);
    })
  );
  routes.post("/:publicId/pair/revoke", (c) =>
    pairRequest(c, async (token, _body, publicId) => {
      await connections(c).peerRevoked(token, publicId);
    })
  );

  // Nothing under `/a2a` falls through to the pages.
  routes.all("*", (c) => c.json({ error: "Not found." }, 404));

  return routes;
};

/**
 * Mounts `/a2a` on the app. `compose` builds the services for these requests.
 * Mount it before the catch-all that hands requests to the pages, and never
 * under `cookieGroup()` or `csrf()`: callers are other servers with a bearer
 * token and no cookie.
 */
export const mountA2aRoutes = (
  app: Hono<AppEnv>,
  compose: MiddlewareHandler<AppEnv>,
  options: A2aRoutesOptions = {}
): void => {
  app.use("/a2a/*", compose);
  app.route("/a2a", a2aRoutes(options));
};
