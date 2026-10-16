import { expect, test } from "bun:test";
import { parseRpc, runSmoke } from "./smoke-mcp.ts";

const json = (result: unknown) =>
  new Response(JSON.stringify({ id: 1, jsonrpc: "2.0", result }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });

const TOOLS = [
  "get_run",
  "list_agents",
  "list_sessions",
  "read_session",
  "search_sessions",
  "send_message",
].map((name) => ({ name }));

/** A server that echoes, as the fake runtime does. */
const fakeServer = (echo: (text: string) => string) => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const fetchFake = (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: { arguments?: Record<string, unknown>; name?: string };
    };
    calls.push({ method: body.method, params: body.params });
    if (body.method === "tools/list") {
      return Promise.resolve(json({ tools: TOOLS }));
    }
    if (body.params.name === "send_message") {
      const answer = echo(String(body.params.arguments?.text));
      return Promise.resolve(
        json({ structuredContent: { answer, sessionId: "s1", state: "done" } })
      );
    }
    return Promise.resolve(
      json({
        structuredContent: { entries: [{ text: echo("ping from smoke-mcp") }] },
      })
    );
  };
  return { calls, fetchFake };
};

const run = (
  fetchFake: (url: string, init: RequestInit) => Promise<Response>
) =>
  runSmoke({
    agent: "fake-echo",
    fetch: fetchFake,
    key: "hm_key_test",
    log: () => undefined,
    server: "http://localhost:3000/",
  });

test("passes when the server lists the tools and echoes", async () => {
  const { calls, fetchFake } = fakeServer((text) => `Echo: ${text}`);
  await run(fetchFake);
  expect(calls.map((call) => call.method)).toEqual([
    "tools/list",
    "tools/call",
    "tools/call",
  ]);
  expect(calls.at(1)?.params.arguments).toMatchObject({
    agent: "fake-echo",
    waitMs: 5000,
  });
});

test("fails when the answer is not an echo of the message", async () => {
  const { fetchFake } = fakeServer(() => "something else");
  await expect(run(fetchFake)).rejects.toThrow("Expected an echo");
});

test("fails with the status when the server refuses the key", async () => {
  const refuse = () => Promise.resolve(new Response("nope", { status: 401 }));
  await expect(run(refuse)).rejects.toThrow("401");
});

test("reads a JSON-RPC message from an event stream", () => {
  const stream = 'event: message\ndata: {"id":1,"result":{"ok":true}}\n\n';
  expect(parseRpc("text/event-stream", stream)).toEqual({
    id: 1,
    result: { ok: true },
  });
});
