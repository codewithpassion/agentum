import { expect, test } from "bun:test";
import { parseRpc, runSmoke } from "./smoke-mcp.ts";

const json = (result: unknown) =>
  new Response(JSON.stringify({ id: 1, jsonrpc: "2.0", result }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });

const TOOLS = [
  "get_run",
  "inbox_list",
  "inbox_post",
  "inbox_read",
  "list_agents",
  "list_sessions",
  "read_session",
  "search_sessions",
  "send_message",
].map((name) => ({ name }));

const THREADS = [
  {
    createdAt: "2026-10-01T00:00:00Z",
    id: "thread-1",
    lastPostAt: null,
    title: "General",
  },
];

const RUN = { agentId: "fake-echo", runId: "run-1" };

interface FakeOptions {
  /** Echoes the message, as the fake runtime does. */
  echo?: (text: string) => string;
  /** The inbox_read call on which the agent's reply first appears. */
  replyOnRead?: number;
  runs?: { agentId: string; runId: string }[];
  threads?: unknown[];
}

/** A server that echoes, as the fake runtime does, and answers the inbox tools. */
const fakeServer = ({
  echo = (text: string) => `Echo: ${text}`,
  replyOnRead = 3,
  runs = [RUN],
  threads = THREADS,
}: FakeOptions = {}) => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let reads = 0;
  const fetchFake = (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: { arguments?: Record<string, unknown>; name?: string };
    };
    calls.push({ method: body.method, params: body.params });
    if (body.method === "tools/list") {
      return Promise.resolve(json({ tools: TOOLS }));
    }
    const args = body.params.arguments ?? {};
    switch (body.params.name) {
      case "send_message": {
        const answer = echo(String(args.text));
        return Promise.resolve(
          json({
            structuredContent: { answer, sessionId: "s1", state: "done" },
          })
        );
      }
      case "read_session":
        return Promise.resolve(
          json({
            structuredContent: {
              entries: [{ text: echo("ping from smoke-mcp") }],
            },
          })
        );
      case "inbox_list":
        return Promise.resolve(json({ structuredContent: { threads } }));
      case "inbox_post":
        return Promise.resolve(
          json({
            structuredContent: {
              post: { id: "post-1", text: args.text },
              runs,
            },
          })
        );
      case "inbox_read": {
        reads += 1;
        const posts: Record<string, unknown>[] = [
          {
            authorId: "user-1",
            authorKind: "user",
            createdAt: "2026-10-01T00:00:01Z",
            id: "post-1",
            runId: null,
            text: "@fake-echo ping from smoke-mcp inbox",
          },
        ];
        if (reads >= replyOnRead && runs[0]) {
          posts.push({
            authorId: "fake-echo",
            authorKind: "agent",
            createdAt: "2026-10-01T00:00:02Z",
            id: "post-2",
            runId: runs[0].runId,
            text: "Echo: @fake-echo ping from smoke-mcp inbox",
          });
        }
        return Promise.resolve(
          json({ structuredContent: { posts, thread: THREADS[0] } })
        );
      }
      default:
        throw new Error(`Unexpected tool ${String(body.params.name)}`);
    }
  };
  return { calls, fetchFake };
};

const toolCalls = (
  calls: { params: Record<string, unknown> }[],
  name: string
) => calls.filter((call) => call.params.name === name);

const run = (
  fetchFake: (url: string, init: RequestInit) => Promise<Response>,
  extra: { thread?: string } = {}
) =>
  runSmoke({
    agent: "fake-echo",
    fetch: fetchFake,
    key: "hm_key_test",
    log: () => undefined,
    server: "http://localhost:3000/",
    sleep: () => Promise.resolve(),
    ...extra,
  });

test("passes when the server lists the tools and echoes", async () => {
  const { calls, fetchFake } = fakeServer();
  await run(fetchFake);
  expect(calls.map((call) => call.method)).toEqual([
    "tools/list",
    "tools/call",
    "tools/call",
    "tools/call",
    "tools/call",
    "tools/call",
    "tools/call",
    "tools/call",
  ]);
  expect(calls.map((call) => call.params.name).slice(1)).toEqual([
    "send_message",
    "read_session",
    "inbox_list",
    "inbox_post",
    "inbox_read",
    "inbox_read",
    "inbox_read",
  ]);
  expect(calls.at(1)?.params.arguments).toMatchObject({
    agent: "fake-echo",
    waitMs: 5000,
  });
});

test("passes when the reply post appears on the third read", async () => {
  const { calls, fetchFake } = fakeServer({ replyOnRead: 3 });
  await run(fetchFake);
  expect(toolCalls(calls, "inbox_read")).toHaveLength(3);
  expect(toolCalls(calls, "inbox_post").at(0)?.params.arguments).toEqual({
    text: "@fake-echo ping from smoke-mcp inbox",
    threadId: "thread-1",
  });
});

test("fails with the run id when the reply never appears, after the limit", async () => {
  const { calls, fetchFake } = fakeServer({
    replyOnRead: Number.POSITIVE_INFINITY,
  });
  await expect(run(fetchFake)).rejects.toThrow(
    "No reply to run run-1 in thread thread-1 after 10 s."
  );
  // Reads at 0 s through 10 s, one per second.
  expect(toolCalls(calls, "inbox_read")).toHaveLength(11);
});

test("fails when inbox_list returns no threads and no thread was given", async () => {
  const { calls, fetchFake } = fakeServer({ threads: [] });
  await expect(run(fetchFake)).rejects.toThrow(
    "No inbox thread. Create one on the Inbox page, or pass --thread <id>."
  );
  expect(toolCalls(calls, "inbox_post")).toHaveLength(0);
});

test("uses the given thread and does not call inbox_list", async () => {
  const { calls, fetchFake } = fakeServer({ threads: [] });
  await run(fetchFake, { thread: "thread-9" });
  expect(toolCalls(calls, "inbox_list")).toHaveLength(0);
  expect(toolCalls(calls, "inbox_post").at(0)?.params.arguments).toMatchObject({
    threadId: "thread-9",
  });
  expect(toolCalls(calls, "inbox_read").at(0)?.params.arguments).toEqual({
    threadId: "thread-9",
  });
});

test("fails when the mention starts no run", async () => {
  const { fetchFake } = fakeServer({ runs: [] });
  await expect(run(fetchFake)).rejects.toThrow(
    'The mention started no run. The agent slug "fake-echo" must exist and be active.'
  );
});

test("fails when the answer is not an echo of the message", async () => {
  const { fetchFake } = fakeServer({ echo: () => "something else" });
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
