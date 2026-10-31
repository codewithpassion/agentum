import { z } from "zod";
import { type AgentCard, agentCardSchema } from "./agent-card.ts";
import {
  buildJsonRpcRequest,
  type JsonRpcMethod,
  parseJsonRpcResponse,
} from "./jsonrpc.ts";
import { type Part, type Struct, structSchema } from "./messages.ts";
import type { A2aFetch } from "./peer-fetch.ts";
import {
  A2A_BINDINGS,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  type A2aBinding,
} from "./protocol.ts";
import {
  listTasksResponseSchema,
  type SendMessageRequest,
  type SendMessageResponse,
  sendMessageResponseSchema,
} from "./requests.ts";
import { type Task, taskSchema } from "./tasks.ts";

export type ClientCredential =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "api_key_header"; headerName: string; value: string }
  | {
      kind: "oauth2_client_credentials";
      clientId: string;
      clientSecret: string;
      scopes: string[];
      tokenUrl: string;
    };

type OAuthCredential = Extract<
  ClientCredential,
  { kind: "oauth2_client_credentials" }
>;

export interface PickedInterface {
  binding: A2aBinding;
  origin: string;
  url: string;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_LIFETIME_S = 300;
/** An OAuth token is refreshed this long before its expiry. */
const TOKEN_MARGIN_MS = 30_000;
const MAX_ERROR_MESSAGE = 300;
const TRAILING_SLASHES = /\/+$/;

const isA2aBinding = (value: string): value is A2aBinding =>
  (A2A_BINDINGS as readonly string[]).includes(value);

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * The interface to call: JSONRPC at protocol 1.0 first, then any 1.0
 * interface, then the first one. Only bindings this package speaks count.
 */
export const pickInterface = (card: AgentCard): PickedInterface | null => {
  const callable = card.supportedInterfaces.flatMap((entry) =>
    isA2aBinding(entry.protocolBinding)
      ? [{ ...entry, protocolBinding: entry.protocolBinding }]
      : []
  );
  const chosen =
    callable.find(
      (entry) =>
        entry.protocolBinding === "JSONRPC" && entry.protocolVersion === "1.0"
    ) ??
    callable.find((entry) => entry.protocolVersion === "1.0") ??
    callable[0];
  const origin = chosen === undefined ? null : originOf(chosen.url);
  if (chosen === undefined || origin === null) {
    return null;
  }
  return { binding: chosen.protocolBinding, origin, url: chosen.url };
};

export type A2aClientErrorKind =
  | "auth"
  | "http"
  | "invalid_response"
  | "network"
  | "rpc"
  | "timeout"
  | "too_large";

/** Messages never carry the credential, the OAuth token or the request body. */
export class A2aClientError extends Error {
  readonly kind: A2aClientErrorKind;
  /** HTTP status, when the peer answered over HTTP. */
  readonly status?: number;
  /** JSON-RPC error code, or the code in a REST error body. */
  readonly rpcCode?: number;

  constructor(
    kind: A2aClientErrorKind,
    message: string,
    extra?: { status?: number; rpcCode?: number }
  ) {
    super(message);
    this.name = "A2aClientError";
    this.kind = kind;
    this.status = extra?.status;
    this.rpcCode = extra?.rpcCode;
  }
}

export interface A2aClientOptions {
  credential: ClientCredential;
  fetch: A2aFetch;
  interface: { binding: A2aBinding; url: string };
  maxBodyBytes?: number;
  now?: () => number;
  timeoutMs?: number;
}

export interface A2aClient {
  cancelTask: (taskId: string) => Promise<Task>;
  /** Registers a push webhook. Resolves when the peer accepted (2xx, no JSON-RPC error). The reply body is not interpreted beyond being JSON. */
  createPushConfig: (
    taskId: string,
    config: {
      authentication?: { credentials?: string; scheme: string };
      token?: string;
      url: string;
    }
  ) => Promise<void>;
  getTask: (taskId: string) => Promise<Task>;
  listTasks: (params: {
    contextId?: string;
    pageSize?: number;
  }) => Promise<Task[]>;
  sendMessage: (request: SendMessageRequest) => Promise<SendMessageResponse>;
}

interface Limits {
  maxBodyBytes: number;
  timeoutMs: number;
}

interface Reply {
  body: string;
  ok: boolean;
  status: number;
}

interface HttpCall {
  body?: unknown;
  method: "GET" | "POST";
  path: string;
}

interface RpcCall {
  method: JsonRpcMethod;
  params?: Struct;
}

/** One operation, in both bindings. */
interface Call {
  http: HttpCall;
  rpc: RpcCall;
}

const invalidResponse = (
  message = "The peer sent a malformed answer"
): A2aClientError => new A2aClientError("invalid_response", message);

const tooLarge = (): A2aClientError =>
  new A2aClientError("too_large", "The peer's answer is larger than the limit");

const truncate = (text: string): string => text.slice(0, MAX_ERROR_MESSAGE);

/** Parses JSON, or gives undefined when the text is not JSON. */
const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON. The caller decides what that means.
  }
};

const parseWith = <S extends z.ZodType>(
  schema: S,
  value: unknown
): z.output<S> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalidResponse();
  }
  return parsed.data;
};

const parseBody = (text: string): unknown => {
  const value = tryJson(text);
  if (value === undefined) {
    throw invalidResponse("The peer sent an answer that is not JSON");
  }
  return value;
};

/** The value as JSON: undefined keys dropped, so it is the form on the wire. */
const wire = (value: object): Struct =>
  structSchema.parse(JSON.parse(JSON.stringify(value)));

/** Reads the body, stopping once it passes the limit. */
const readCapped = async (
  response: Response,
  limit: number
): Promise<string> => {
  if (response.body === null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) {
      throw tooLarge();
    }
    return text;
  }
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let received = 0;
  let text = "";
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: chunks must be read in order
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
};

const classify = (error: unknown): A2aClientError => {
  if (error instanceof A2aClientError) {
    return error;
  }
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return new A2aClientError("timeout", "The peer did not answer in time");
  }
  return new A2aClientError("network", "The peer could not be reached");
};

const fetchReply = async (
  fetchPeer: A2aFetch,
  url: string,
  init: { body?: string; headers: Record<string, string>; method: string },
  limits: Limits
): Promise<Reply> => {
  try {
    const response = await fetchPeer(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(limits.timeoutMs),
    });
    return {
      body: await readCapped(response, limits.maxBodyBytes),
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    throw classify(error);
  }
};

const isAuthStatus = (status: number): boolean =>
  status === 401 || status === 403;

const authFailure = (status: number): A2aClientError =>
  new A2aClientError("auth", "The peer refused the credential", { status });

const restErrorSchema = z.object({
  error: z
    .object({
      code: z.number().optional(),
      message: z.string().optional(),
    })
    .optional(),
  message: z.string().optional(),
});

/** A non-2xx answer that is not JSON-RPC: `google.rpc.Status` or a top-level message. */
const httpFailure = (status: number, body: string): A2aClientError => {
  const parsed = restErrorSchema.safeParse(tryJson(body));
  const detail = parsed.success ? parsed.data : undefined;
  const message = detail?.error?.message ?? detail?.message;
  return new A2aClientError(
    "http",
    message === undefined
      ? `The peer answered with HTTP ${status}`
      : truncate(message),
    { rpcCode: detail?.error?.code, status }
  );
};

const statusFailure = (status: number, body: string): A2aClientError =>
  isAuthStatus(status) ? authFailure(status) : httpFailure(status, body);

const base64 = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const tokenGrantSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().default(DEFAULT_TOKEN_LIFETIME_S),
  token_type: z
    .string()
    .regex(/^bearer$/i)
    .optional(),
});

/** Fetches an OAuth token. Any failure is kind "auth", and no message names the secret. */
const requestToken = async (
  fetchPeer: A2aFetch,
  oauth: OAuthCredential,
  limits: Limits
): Promise<{ accessToken: string; expiresIn: number }> => {
  const form = new URLSearchParams({ grant_type: "client_credentials" });
  if (oauth.scopes.length > 0) {
    form.set("scope", oauth.scopes.join(" "));
  }
  let reply: Reply;
  try {
    reply = await fetchReply(
      fetchPeer,
      oauth.tokenUrl,
      {
        body: form.toString(),
        headers: {
          Authorization: `Basic ${base64(`${oauth.clientId}:${oauth.clientSecret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
      limits
    );
  } catch {
    // biome-ignore lint/style/useErrorCause: the token endpoint's failure is reported as one auth error, with no detail from it, so nothing it sent can reach a message or a log.
    throw new A2aClientError("auth", "The token request failed");
  }
  const grant = reply.ok
    ? tokenGrantSchema.safeParse(tryJson(reply.body))
    : undefined;
  if (grant === undefined || !grant.success) {
    throw new A2aClientError("auth", "The token endpoint granted no token");
  }
  return {
    accessToken: grant.data.access_token,
    expiresIn: grant.data.expires_in,
  };
};

const pushConfigBody = (
  taskId: string,
  config: Parameters<A2aClient["createPushConfig"]>[1]
): Struct => {
  const detail = wire(config);
  return { ...detail, pushNotificationConfig: detail, taskId };
};

const sameTask = (task: Task, taskId: string): Task => {
  if (task.id !== taskId) {
    throw invalidResponse("The peer answered with another task");
  }
  return task;
};

const textParts = (parts: Part[]): string[] =>
  parts.flatMap((part) => (part.text === undefined ? [] : [part.text]));

/**
 * The text a person reads: the text parts of the first artifact that has
 * any, else of the status message, joined by a blank line.
 */
export const taskText = (task: Task): string => {
  const artifact = task.artifacts?.find(
    (candidate) => textParts(candidate.parts).length > 0
  );
  const parts =
    artifact === undefined
      ? (task.status.message?.parts ?? [])
      : artifact.parts;
  return textParts(parts).join("\n\n");
};

const limitsOf = (options: {
  maxBodyBytes?: number;
  timeoutMs?: number;
}): Limits => ({
  maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
});

export const createA2aClient = (options: A2aClientOptions): A2aClient => {
  const { credential, fetch: fetchPeer } = options;
  const { binding, url: peerUrl } = options.interface;
  const limits = limitsOf(options);
  const now = options.now ?? Date.now;
  const restBase = peerUrl.replace(TRAILING_SLASHES, "");
  let nextId = 1;
  let cachedToken: { expiresAt: number; value: string } | null = null;

  const oauthToken = async (oauth: OAuthCredential): Promise<string> => {
    if (cachedToken !== null && now() < cachedToken.expiresAt) {
      return cachedToken.value;
    }
    const grant = await requestToken(fetchPeer, oauth, limits);
    cachedToken = {
      expiresAt: now() + grant.expiresIn * 1000 - TOKEN_MARGIN_MS,
      value: grant.accessToken,
    };
    return grant.accessToken;
  };

  const authorizationHeaders = async (): Promise<Record<string, string>> => {
    if (credential.kind === "none") {
      return {};
    }
    if (credential.kind === "bearer") {
      return { Authorization: `Bearer ${credential.token}` };
    }
    if (credential.kind === "api_key_header") {
      return { [credential.headerName]: credential.value };
    }
    return { Authorization: `Bearer ${await oauthToken(credential)}` };
  };

  const requestHeaders = async (
    hasBody: boolean
  ): Promise<Record<string, string>> => ({
    ...(await authorizationHeaders()),
    Accept: "application/json",
    [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
  });

  const rpcExchange = async (call: RpcCall): Promise<unknown> => {
    const id = nextId;
    nextId += 1;
    const reply = await fetchReply(
      fetchPeer,
      peerUrl,
      {
        body: JSON.stringify(buildJsonRpcRequest(id, call.method, call.params)),
        headers: await requestHeaders(true),
        method: "POST",
      },
      limits
    );
    if (isAuthStatus(reply.status)) {
      throw authFailure(reply.status);
    }
    const parsed = parseJsonRpcResponse(reply.body);
    if (parsed.type === "invalid") {
      throw reply.ok
        ? invalidResponse()
        : httpFailure(reply.status, reply.body);
    }
    if (parsed.id !== null && String(parsed.id) !== String(id)) {
      throw invalidResponse("The peer answered another request");
    }
    if (parsed.type === "error") {
      throw new A2aClientError("rpc", truncate(parsed.error.message), {
        rpcCode: parsed.error.code,
        status: reply.status,
      });
    }
    if (!reply.ok) {
      throw httpFailure(reply.status, reply.body);
    }
    return parsed.result;
  };

  const restExchange = async (call: HttpCall): Promise<unknown> => {
    const hasBody = call.body !== undefined;
    const reply = await fetchReply(
      fetchPeer,
      `${restBase}${call.path}`,
      {
        body: hasBody ? JSON.stringify(call.body) : undefined,
        headers: await requestHeaders(hasBody),
        method: call.method,
      },
      limits
    );
    if (!reply.ok) {
      throw statusFailure(reply.status, reply.body);
    }
    return parseBody(reply.body);
  };

  const exchange = (call: Call): Promise<unknown> =>
    binding === "JSONRPC" ? rpcExchange(call.rpc) : restExchange(call.http);

  /** A 401 with an OAuth token drops the token and tries the call once more. */
  const exchangeOnce = async (call: Call): Promise<unknown> => {
    try {
      return await exchange(call);
    } catch (error) {
      const unauthorized =
        error instanceof A2aClientError &&
        error.kind === "auth" &&
        error.status === 401;
      if (credential.kind !== "oauth2_client_credentials" || !unauthorized) {
        throw error;
      }
      cachedToken = null;
      return exchange(call);
    }
  };

  const run = async <S extends z.ZodType>(
    call: Call,
    schema: S
  ): Promise<z.output<S>> => parseWith(schema, await exchangeOnce(call));

  return {
    cancelTask: async (taskId) =>
      sameTask(
        await run(
          {
            http: {
              body: {},
              method: "POST",
              path: `/tasks/${encodeURIComponent(taskId)}:cancel`,
            },
            rpc: { method: "CancelTask", params: { id: taskId } },
          },
          taskSchema
        ),
        taskId
      ),

    createPushConfig: async (taskId, config) => {
      const body = pushConfigBody(taskId, config);
      await run(
        {
          http: {
            body,
            method: "POST",
            path: `/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs`,
          },
          rpc: {
            method: "CreateTaskPushNotificationConfig",
            params: body,
          },
        },
        structSchema
      );
    },

    getTask: async (taskId) =>
      sameTask(
        await run(
          {
            http: {
              method: "GET",
              path: `/tasks/${encodeURIComponent(taskId)}`,
            },
            rpc: { method: "GetTask", params: { id: taskId } },
          },
          taskSchema
        ),
        taskId
      ),

    listTasks: async ({ contextId, pageSize }) => {
      const query = new URLSearchParams();
      if (contextId !== undefined) {
        query.set("contextId", contextId);
      }
      if (pageSize !== undefined) {
        query.set("pageSize", String(pageSize));
      }
      const queryString = query.toString();
      const { tasks } = await run(
        {
          http: {
            method: "GET",
            path: queryString === "" ? "/tasks" : `/tasks?${queryString}`,
          },
          rpc: { method: "ListTasks", params: wire({ contextId, pageSize }) },
        },
        listTasksResponseSchema
      );
      return tasks;
    },
    sendMessage: (request) =>
      run(
        {
          http: { body: request, method: "POST", path: "/message:send" },
          rpc: { method: "SendMessage", params: wire(request) },
        },
        sendMessageResponseSchema
      ),
  };
};

/** GET a card and validate it. A card that fails the schema is kind "invalid_response". */
export const readAgentCard = async (
  fetchPeer: A2aFetch,
  cardUrl: string,
  options: { maxBodyBytes?: number; timeoutMs?: number } = {}
): Promise<AgentCard> => {
  const reply = await fetchReply(
    fetchPeer,
    cardUrl,
    { headers: { Accept: "application/json" }, method: "GET" },
    limitsOf(options)
  );
  if (!reply.ok) {
    throw statusFailure(reply.status, reply.body);
  }
  return parseWith(agentCardSchema, parseBody(reply.body));
};
