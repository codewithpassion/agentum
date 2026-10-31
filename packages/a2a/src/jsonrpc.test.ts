import { describe, expect, test } from "bun:test";
import { jsonRpcError } from "./errors.ts";
import {
  buildJsonRpcErrorResponse,
  buildJsonRpcRequest,
  buildJsonRpcResult,
  isJsonRpcMethod,
  JSONRPC_METHODS,
  JSONRPC_STREAMING_METHODS,
  parseJsonRpcRequest,
  parseJsonRpcResponse,
} from "./jsonrpc.ts";

describe("JSON-RPC", () => {
  test("a request round trips through parse", () => {
    const request = buildJsonRpcRequest(7, "SendMessage", {
      message: { messageId: "m1", parts: [{ text: "hi" }], role: "ROLE_USER" },
    });
    const parsed = parseJsonRpcRequest(JSON.stringify(request));
    expect(parsed).toEqual({
      id: 7,
      method: "SendMessage",
      ok: true,
      params: request.params,
    });
  });

  test("a request without params parses", () => {
    const parsed = parseJsonRpcRequest(
      JSON.stringify(buildJsonRpcRequest("a", "GetExtendedAgentCard"))
    );
    expect(parsed).toEqual({
      id: "a",
      method: "GetExtendedAgentCard",
      ok: true,
      params: undefined,
    });
  });

  test("a result round trips through parseJsonRpcResponse", () => {
    const task = { id: "t1", status: { state: "TASK_STATE_WORKING" } };
    const body = JSON.stringify(buildJsonRpcResult(1, { task }));
    expect(parseJsonRpcResponse(body)).toEqual({
      id: 1,
      result: { task },
      type: "result",
    });
  });

  test("an error response round trips and keeps its ErrorInfo", () => {
    const error = jsonRpcError("TaskNotFoundError", {
      metadata: { taskId: "x" },
    });
    const body = JSON.stringify(buildJsonRpcErrorResponse("r", error));
    expect(parseJsonRpcResponse(body)).toEqual({
      error,
      id: "r",
      type: "error",
    });
  });

  test("an error without data, as Hermes sends, parses with its code and message", () => {
    const body =
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"no such task"}}';
    expect(parseJsonRpcResponse(body)).toEqual({
      error: { code: -32_001, message: "no such task" },
      id: 1,
      type: "error",
    });
  });

  test("an error whose data is not an array still parses", () => {
    const body =
      '{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"x","data":"why"}}';
    expect(parseJsonRpcResponse(body).type).toBe("error");
  });

  test("a body that is not JSON is a JSONParseError with a null id", () => {
    const parsed = parseJsonRpcRequest("{nope");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.response.id).toBeNull();
      expect(parsed.response.error?.code).toBe(-32_700);
    }
  });

  test("a body that is not a request is an InvalidRequestError", () => {
    for (const body of [
      "[]",
      '{"jsonrpc":"1.0","id":1,"method":"GetTask"}',
      '{"jsonrpc":"2.0","method":"GetTask"}',
      '{"jsonrpc":"2.0","id":1}',
    ]) {
      const parsed = parseJsonRpcRequest(body);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.response.error?.code).toBe(-32_600);
      }
    }
  });

  test("an invalid request keeps the id it can read", () => {
    const parsed = parseJsonRpcRequest('{"jsonrpc":"1.0","id":9,"method":"x"}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.response.id).toBe(9);
    }
  });

  test("an unknown method is a MethodNotFoundError with the request id", () => {
    const parsed = parseJsonRpcRequest(
      '{"jsonrpc":"2.0","id":3,"method":"message/send"}'
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.response.id).toBe(3);
      expect(parsed.response.error?.code).toBe(-32_601);
    }
  });

  test("a response with both or neither of result and error is invalid", () => {
    expect(
      parseJsonRpcResponse(
        '{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":1,"message":"x"}}'
      )
    ).toEqual({ type: "invalid" });
    expect(parseJsonRpcResponse('{"jsonrpc":"2.0","id":1}')).toEqual({
      type: "invalid",
    });
    expect(parseJsonRpcResponse("nope")).toEqual({ type: "invalid" });
  });

  test("every method of the spec table is known, and the streaming ones are among them", () => {
    expect(JSONRPC_METHODS).toHaveLength(11);
    for (const method of JSONRPC_METHODS) {
      expect(isJsonRpcMethod(method)).toBe(true);
    }
    for (const method of JSONRPC_STREAMING_METHODS) {
      expect(isJsonRpcMethod(method)).toBe(true);
    }
    expect(isJsonRpcMethod("tasks/get")).toBe(false);
  });
});
