import { describe, expect, test } from "bun:test";
import {
  A2A_ERRORS,
  type A2aErrorName,
  type ErrorSpec,
  errorStatus,
  jsonRpcError,
  PROTOCOL_ERRORS,
  type ProtocolErrorName,
  restErrorBody,
} from "./errors.ts";

const TRAILING_ERROR = /Error$/;
const WORD_BREAK = /([a-z])([A-Z])/g;

// Spec section 5.4, written out again so a typo in the table shows up here.
const SPEC_ROWS: [A2aErrorName, number, number, string][] = [
  ["TaskNotFoundError", -32_001, 404, "TASK_NOT_FOUND"],
  ["TaskNotCancelableError", -32_002, 400, "TASK_NOT_CANCELABLE"],
  [
    "PushNotificationNotSupportedError",
    -32_003,
    400,
    "PUSH_NOTIFICATION_NOT_SUPPORTED",
  ],
  ["UnsupportedOperationError", -32_004, 400, "UNSUPPORTED_OPERATION"],
  ["ContentTypeNotSupportedError", -32_005, 400, "CONTENT_TYPE_NOT_SUPPORTED"],
  ["InvalidAgentResponseError", -32_006, 500, "INVALID_AGENT_RESPONSE"],
  [
    "ExtendedAgentCardNotConfiguredError",
    -32_007,
    400,
    "EXTENDED_AGENT_CARD_NOT_CONFIGURED",
  ],
  ["ExtensionSupportRequiredError", -32_008, 400, "EXTENSION_SUPPORT_REQUIRED"],
  ["VersionNotSupportedError", -32_009, 400, "VERSION_NOT_SUPPORTED"],
];

describe("the A2A error table", () => {
  test("has exactly the nine rows of spec section 5.4", () => {
    expect(Object.keys(A2A_ERRORS).sort()).toEqual(
      SPEC_ROWS.map(([name]) => name).sort()
    );
  });

  for (const [name, code, httpStatus, reason] of SPEC_ROWS) {
    describe(name, () => {
      test("row", () => {
        const spec: ErrorSpec = A2A_ERRORS[name];
        expect(spec.code).toBe(code);
        expect(spec.httpStatus).toBe(httpStatus);
        expect(spec.reason).toBe(reason);
        expect(errorStatus(name)).toBe(httpStatus);
      });

      test("reason is the name in upper snake case without Error", () => {
        const snake = name
          .replace(TRAILING_ERROR, "")
          .replace(WORD_BREAK, "$1_$2")
          .toUpperCase();
        expect(reason).toBe(snake);
      });

      test("JSON-RPC body carries the code and an ErrorInfo", () => {
        const body = jsonRpcError(name, { metadata: { taskId: "t1" } });
        expect(body.code).toBe(code);
        expect(body.message).toBe(A2A_ERRORS[name].message);
        expect(body.data).toEqual([
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            domain: "a2a-protocol.org",
            metadata: { taskId: "t1" },
            reason,
          },
        ]);
      });

      test("REST body is a google.rpc.Status with an ErrorInfo", () => {
        const body = restErrorBody(name);
        expect(body.error.code).toBe(httpStatus);
        expect(body.error.status).toBe(A2A_ERRORS[name].grpcStatus);
        expect(body.error.details).toEqual([
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            domain: "a2a-protocol.org",
            reason,
          },
        ]);
      });
    });
  }

  test("gRPC statuses match spec section 5.4", () => {
    expect(A2A_ERRORS.TaskNotFoundError.grpcStatus).toBe("NOT_FOUND");
    expect(A2A_ERRORS.ContentTypeNotSupportedError.grpcStatus).toBe(
      "INVALID_ARGUMENT"
    );
    expect(A2A_ERRORS.InvalidAgentResponseError.grpcStatus).toBe("INTERNAL");
    expect(A2A_ERRORS.VersionNotSupportedError.grpcStatus).toBe(
      "FAILED_PRECONDITION"
    );
  });

  test("a custom message replaces the default", () => {
    expect(jsonRpcError("TaskNotFoundError", { message: "gone" }).message).toBe(
      "gone"
    );
    expect(
      restErrorBody("TaskNotFoundError", { message: "gone" }).error.message
    ).toBe("gone");
  });

  test("extra details follow the ErrorInfo", () => {
    const detail = {
      "@type": "type.googleapis.com/google.rpc.BadRequest",
      fieldViolations: [{ description: "needed", field: "message.parts" }],
    };
    const body = restErrorBody("UnsupportedOperationError", {
      details: [detail],
    });
    expect(body.error.details).toHaveLength(2);
    expect(body.error.details[1]).toEqual(detail);
  });
});

describe("the JSON-RPC standard errors", () => {
  const rows: [ProtocolErrorName, number][] = [
    ["JSONParseError", -32_700],
    ["InvalidRequestError", -32_600],
    ["MethodNotFoundError", -32_601],
    ["InvalidParamsError", -32_602],
    ["InternalError", -32_603],
  ];
  for (const [name, code] of rows) {
    test(`${name} is ${code} and has no ErrorInfo`, () => {
      const spec: ErrorSpec = PROTOCOL_ERRORS[name];
      expect(spec.code).toBe(code);
      expect(jsonRpcError(name).code).toBe(code);
      expect(jsonRpcError(name).data).toBeUndefined();
      expect(restErrorBody(name).error.details).toEqual([]);
    });
  }
});
