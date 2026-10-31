import { z } from "zod";
import { type JsonRpcErrorObject, jsonRpcError } from "./errors.ts";
import { structSchema } from "./messages.ts";

/** The A2A operations as JSON-RPC method names (spec section 5.3). */
export const JSONRPC_METHODS = [
  "SendMessage",
  "SendStreamingMessage",
  "GetTask",
  "ListTasks",
  "CancelTask",
  "SubscribeToTask",
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
  "GetExtendedAgentCard",
] as const;
export type JsonRpcMethod = (typeof JSONRPC_METHODS)[number];

/** These answer with a `text/event-stream` of `StreamResponse` results. */
export const JSONRPC_STREAMING_METHODS = [
  "SendStreamingMessage",
  "SubscribeToTask",
] as const satisfies readonly JsonRpcMethod[];

export const isJsonRpcMethod = (method: string): method is JsonRpcMethod =>
  (JSONRPC_METHODS as readonly string[]).includes(method);

const idSchema = z.union([z.string(), z.number()]);
export type JsonRpcId = z.infer<typeof idSchema>;

export const jsonRpcRequestSchema = z.object({
  id: idSchema,
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.union([structSchema, z.array(z.json())]).optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

const errorObjectSchema = z.object({
  code: z.number().int(),
  data: z.array(z.record(z.string(), z.json())).optional(),
  message: z.string(),
});

/** A response holds a `result` or an `error`. The id is null when the request's id could not be read. */
export const jsonRpcResponseSchema = z
  .object({
    error: errorObjectSchema.optional(),
    id: idSchema.nullable(),
    jsonrpc: z.literal("2.0"),
    result: z.json().optional(),
  })
  .refine(
    (value) => (value.error === undefined) !== (value.result === undefined),
    {
      message: "A response holds exactly one of result and error",
    }
  );
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

export const buildJsonRpcRequest = (
  id: JsonRpcId,
  method: JsonRpcMethod,
  params?: JsonRpcRequest["params"]
): JsonRpcRequest => ({
  id,
  jsonrpc: "2.0",
  method,
  ...(params === undefined ? {} : { params }),
});

export const buildJsonRpcResult = (
  id: JsonRpcId | null,
  result: unknown
): JsonRpcResponse => ({
  id,
  jsonrpc: "2.0",
  result: result as JsonRpcResponse["result"],
});

export const buildJsonRpcErrorResponse = (
  id: JsonRpcId | null,
  error: JsonRpcErrorObject
): JsonRpcResponse => ({ error, id, jsonrpc: "2.0" });

export type ParsedJsonRpcRequest =
  | {
      ok: true;
      id: JsonRpcId;
      method: JsonRpcMethod;
      params: JsonRpcRequest["params"];
    }
  | { ok: false; response: JsonRpcResponse };

const idOf = (value: unknown): JsonRpcId | null => {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
};

/**
 * Reads a request body. Never throws: a body that is not JSON, not a request
 * or names no known method comes back as the response to send.
 */
export const parseJsonRpcRequest = (body: string): ParsedJsonRpcRequest => {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return {
      ok: false,
      response: buildJsonRpcErrorResponse(null, jsonRpcError("JSONParseError")),
    };
  }
  const parsed = jsonRpcRequestSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      response: buildJsonRpcErrorResponse(
        idOf(json),
        jsonRpcError("InvalidRequestError")
      ),
    };
  }
  const { id, method, params } = parsed.data;
  if (!isJsonRpcMethod(method)) {
    return {
      ok: false,
      response: buildJsonRpcErrorResponse(
        id,
        jsonRpcError("MethodNotFoundError")
      ),
    };
  }
  return { id, method, ok: true, params };
};

export type ParsedJsonRpcResponse =
  | { id: JsonRpcId | null; result: unknown; type: "result" }
  | {
      error: NonNullable<JsonRpcResponse["error"]>;
      id: JsonRpcId | null;
      type: "error";
    }
  | { type: "invalid" };

/** Reads a peer's answer to a request we sent. */
export const parseJsonRpcResponse = (body: string): ParsedJsonRpcResponse => {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { type: "invalid" };
  }
  const parsed = jsonRpcResponseSchema.safeParse(json);
  if (!parsed.success) {
    return { type: "invalid" };
  }
  const { error, id, result } = parsed.data;
  return error === undefined
    ? { id, result, type: "result" }
    : { error, id, type: "error" };
};
