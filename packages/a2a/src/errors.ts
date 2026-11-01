import { z } from "zod";
import type { Struct } from "./messages.ts";

/** `domain` of every `google.rpc.ErrorInfo` we send. */
export const A2A_ERROR_DOMAIN = "a2a-protocol.org";

const ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";

/** The `grpcStatus` column is also the `status` string of a REST error body. */
export interface ErrorSpec {
  /** JSON-RPC `error.code`. */
  code: number;
  grpcStatus: string;
  httpStatus: number;
  message: string;
  /** Upper snake case of the name without `Error`, the `ErrorInfo.reason`. */
  reason: string;
}

/** Spec section 5.4 of the v1.0.0 specification, plus the default message of each. */
export const A2A_ERRORS = {
  ContentTypeNotSupportedError: {
    code: -32_005,
    grpcStatus: "INVALID_ARGUMENT",
    httpStatus: 415,
    message: "Content type not supported",
    reason: "CONTENT_TYPE_NOT_SUPPORTED",
  },
  ExtendedAgentCardNotConfiguredError: {
    code: -32_007,
    grpcStatus: "FAILED_PRECONDITION",
    httpStatus: 400,
    message: "Extended agent card not configured",
    reason: "EXTENDED_AGENT_CARD_NOT_CONFIGURED",
  },
  ExtensionSupportRequiredError: {
    code: -32_008,
    grpcStatus: "FAILED_PRECONDITION",
    httpStatus: 400,
    message: "Extension support required",
    reason: "EXTENSION_SUPPORT_REQUIRED",
  },
  InvalidAgentResponseError: {
    code: -32_006,
    grpcStatus: "INTERNAL",
    httpStatus: 502,
    message: "Invalid agent response",
    reason: "INVALID_AGENT_RESPONSE",
  },
  PushNotificationNotSupportedError: {
    code: -32_003,
    grpcStatus: "UNIMPLEMENTED",
    httpStatus: 400,
    message: "Push notification is not supported",
    reason: "PUSH_NOTIFICATION_NOT_SUPPORTED",
  },
  TaskNotCancelableError: {
    code: -32_002,
    grpcStatus: "FAILED_PRECONDITION",
    httpStatus: 409,
    message: "Task cannot be canceled",
    reason: "TASK_NOT_CANCELABLE",
  },
  TaskNotFoundError: {
    code: -32_001,
    grpcStatus: "NOT_FOUND",
    httpStatus: 404,
    message: "Task not found",
    reason: "TASK_NOT_FOUND",
  },
  UnsupportedOperationError: {
    code: -32_004,
    grpcStatus: "UNIMPLEMENTED",
    httpStatus: 400,
    message: "This operation is not supported",
    reason: "UNSUPPORTED_OPERATION",
  },
  VersionNotSupportedError: {
    code: -32_009,
    grpcStatus: "UNIMPLEMENTED",
    httpStatus: 400,
    message: "Protocol version not supported",
    reason: "VERSION_NOT_SUPPORTED",
  },
} as const satisfies Record<string, ErrorSpec>;
export type A2aErrorName = keyof typeof A2A_ERRORS;

/**
 * The JSON-RPC 2.0 errors of spec section 9.5. The spec gives no HTTP mapping
 * for them, so these follow the usual one. They carry no `ErrorInfo`.
 */
export const PROTOCOL_ERRORS = {
  InternalError: {
    code: -32_603,
    grpcStatus: "INTERNAL",
    httpStatus: 500,
    message: "Internal error",
    reason: "INTERNAL",
  },
  InvalidParamsError: {
    code: -32_602,
    grpcStatus: "INVALID_ARGUMENT",
    httpStatus: 400,
    message: "Invalid parameters",
    reason: "INVALID_PARAMS",
  },
  InvalidRequestError: {
    code: -32_600,
    grpcStatus: "INVALID_ARGUMENT",
    httpStatus: 400,
    message: "Request payload validation error",
    reason: "INVALID_REQUEST",
  },
  JSONParseError: {
    code: -32_700,
    grpcStatus: "INVALID_ARGUMENT",
    httpStatus: 400,
    message: "Invalid JSON payload",
    reason: "JSON_PARSE",
  },
  MethodNotFoundError: {
    code: -32_601,
    grpcStatus: "NOT_FOUND",
    httpStatus: 404,
    message: "Method not found",
    reason: "METHOD_NOT_FOUND",
  },
} as const satisfies Record<string, ErrorSpec>;
export type ProtocolErrorName = keyof typeof PROTOCOL_ERRORS;

export type ErrorName = A2aErrorName | ProtocolErrorName;

/** `google.rpc.ErrorInfo` as it appears in `error.data` and `error.details`. */
export const errorInfoSchema = z.object({
  "@type": z.literal(ERROR_INFO_TYPE),
  domain: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
  reason: z.string(),
});
export type ErrorInfo = z.infer<typeof errorInfoSchema>;

export interface ErrorOptions {
  /** Extra `google.rpc` detail objects, after the `ErrorInfo`. */
  details?: Struct[];
  /** Replaces the default message. */
  message?: string;
  /** Goes into `ErrorInfo.metadata`, for example `{ taskId }`. */
  metadata?: Record<string, string>;
}

const specOf = (name: ErrorName): ErrorSpec =>
  name in A2A_ERRORS
    ? A2A_ERRORS[name as A2aErrorName]
    : PROTOCOL_ERRORS[name as ProtocolErrorName];

/** The A2A specific errors carry an `ErrorInfo`; the JSON-RPC standard ones do not. */
const detailsOf = (name: ErrorName, options: ErrorOptions): Struct[] => {
  const extra = options.details ?? [];
  if (!(name in A2A_ERRORS)) {
    return extra;
  }
  const info = {
    "@type": ERROR_INFO_TYPE,
    domain: A2A_ERROR_DOMAIN,
    reason: specOf(name).reason,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  } satisfies ErrorInfo;
  return [info, ...extra];
};

export const errorStatus = (name: ErrorName): number => specOf(name).httpStatus;

/** The JSON-RPC `error` member: `data` is an array of detail objects. */
export const jsonRpcError = (name: ErrorName, options: ErrorOptions = {}) => {
  const spec = specOf(name);
  const data = detailsOf(name, options);
  return {
    code: spec.code,
    ...(data.length > 0 ? { data } : {}),
    message: options.message ?? spec.message,
  };
};
export type JsonRpcErrorObject = ReturnType<typeof jsonRpcError>;

/** The body of an HTTP+JSON error, a `google.rpc.Status`. Send it as `application/json`. */
export const restErrorBody = (name: ErrorName, options: ErrorOptions = {}) => {
  const spec = specOf(name);
  return {
    error: {
      code: spec.httpStatus,
      details: detailsOf(name, options),
      message: options.message ?? spec.message,
      status: spec.grpcStatus,
    },
  };
};
export type RestErrorBody = ReturnType<typeof restErrorBody>;
