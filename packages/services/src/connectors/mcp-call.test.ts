import { describe, expect, test } from "bun:test";
import { callMcpTool, McpError, McpUnauthorizedError } from "./mcp";

const URL_UNDER_TEST = "https://mcp.example.com/mcp";
const BOOM = /boom/;

interface Sent {
  body: Record<string, unknown>;
  headers: Headers;
}

const recorder = (respond: (method: string) => Response) => {
  const sent: Sent[] = [];
  const fetchImpl = ((_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ body, headers: new Headers(init?.headers) });
    return Promise.resolve(respond(String(body.method)));
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
};

const rpcResult = (result: unknown): Response =>
  Response.json({ id: 1, jsonrpc: "2.0", result });

const serverWith =
  (onCall: () => Response) =>
  (method: string): Response => {
    if (method === "initialize") {
      return rpcResult({ serverInfo: { name: "stub" } });
    }
    if (method === "tools/call") {
      return onCall();
    }
    return new Response(null, { status: 202 });
  };

const CALL = { arguments: { title: "Fix it" }, name: "create_issue" };
const HEADER = { name: "X-Api-Key", value: "secret" };

describe("callMcpTool", () => {
  test("handshakes, then sends tools/call with the name, arguments and header", async () => {
    const { fetchImpl, sent } = recorder(
      serverWith(() => rpcResult({ content: [{ text: "ok", type: "text" }] }))
    );

    const result = await callMcpTool(
      URL_UNDER_TEST,
      { fetchImpl, header: HEADER },
      CALL
    );

    expect(result).toEqual({ content: [{ text: "ok", type: "text" }] });
    expect(sent.map((call) => call.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(sent.map((call) => call.body.params).at(-1)).toEqual({
      arguments: { title: "Fix it" },
      name: "create_issue",
    });
    for (const call of sent) {
      expect(call.headers.get("x-api-key")).toBe("secret");
    }
  });

  test("returns an isError result as data", async () => {
    const { fetchImpl } = recorder(
      serverWith(() =>
        rpcResult({ content: [{ text: "nope", type: "text" }], isError: true })
      )
    );

    const result = await callMcpTool(URL_UNDER_TEST, { fetchImpl }, CALL);

    expect(result.isError).toBe(true);
  });

  test("returns an empty object when the envelope has no result", async () => {
    const { fetchImpl } = recorder(serverWith(() => new Response(null)));

    expect(await callMcpTool(URL_UNDER_TEST, { fetchImpl }, CALL)).toEqual({});
  });

  test("reads an SSE-framed answer, skipping notifications", async () => {
    const frames = [
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}`,
      `data: ${JSON.stringify({ id: 1, jsonrpc: "2.0", result: { content: [] } })}`,
      "",
    ].join("\n");
    const { fetchImpl } = recorder(
      serverWith(
        () =>
          new Response(frames, {
            headers: { "content-type": "text/event-stream" },
          })
      )
    );

    expect(await callMcpTool(URL_UNDER_TEST, { fetchImpl }, CALL)).toEqual({
      content: [],
    });
  });

  test("a JSON-RPC error becomes McpError", async () => {
    const { fetchImpl } = recorder(
      serverWith(() =>
        Response.json({
          error: { code: -32_000, message: "boom" },
          id: 1,
          jsonrpc: "2.0",
        })
      )
    );

    await expect(
      callMcpTool(URL_UNDER_TEST, { fetchImpl }, CALL)
    ).rejects.toThrow(BOOM);
    await expect(
      callMcpTool(URL_UNDER_TEST, { fetchImpl }, CALL)
    ).rejects.toBeInstanceOf(McpError);
  });

  test("a 401 becomes McpUnauthorizedError", async () => {
    const { fetchImpl } = recorder(
      serverWith(() => new Response("no", { status: 401 }))
    );

    await expect(
      callMcpTool(URL_UNDER_TEST, { fetchImpl }, CALL)
    ).rejects.toBeInstanceOf(McpUnauthorizedError);
  });
});
