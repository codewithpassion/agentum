#!/usr/bin/env bun
// Smoke check for the platform MCP server. Against `bun run dev` (or any
// deployment) with the seeded fake agent, using an API key made on the API keys
// page (a write key, because steps 2 and 4 send messages). It lists the tools,
// sends a message with `waitMs: 5000`, expects the fake runtime's echo back,
// then reads the session. It then posts a mention of the agent in an inbox
// thread and polls the thread until the agent's reply shows up. The thread is
// the first one `inbox_list` returns, unless `--thread <id>` names one. Run from
// the repo root:
// `bun scripts/smoke-mcp.ts --key hm_key_... [--server <url>] [--agent <slug>] [--thread <id>]`.
import { parseArgs } from "node:util";
import { runCli } from "./dev/local.ts";

const DEFAULT_SERVER = "http://localhost:3000";
const DEFAULT_AGENT = "fake-echo";
const TRAILING_SLASHES = /\/+$/;
const WAIT_MS = 5000;
const MESSAGE = "ping from smoke-mcp";
const INBOX_MESSAGE = "ping from smoke-mcp inbox";
const POLL_MS = 1000;
const POLL_LIMIT_MS = 10_000;
export const EXPECTED_TOOLS = [
  "get_run",
  "inbox_list",
  "inbox_post",
  "inbox_read",
  "list_agents",
  "list_sessions",
  "read_session",
  "search_sessions",
  "send_message",
];

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

interface Config {
  agent: string;
  fetch?: Fetch;
  key: string;
  log?: (line: string) => void;
  server: string;
  sleep?: (ms: number) => Promise<void>;
  thread?: string;
}

interface ToolResult {
  content?: { text?: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The JSON-RPC message of a response, whether it came as JSON or as an event stream. */
export const parseRpc = (contentType: string | null, text: string): unknown => {
  if (!contentType?.includes("event-stream")) {
    return JSON.parse(text);
  }
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  return JSON.parse(data);
};

const stringField = (value: unknown, name: string): string => {
  const field =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[name]
      : undefined;
  if (typeof field !== "string") {
    throw new Error(`Expected a string "${name}" in the tool result.`);
  }
  return field;
};

/** Runs the five steps. Throws on the first one that does not hold. */
export const runSmoke = async ({
  agent,
  fetch: send = fetch,
  key,
  log = (line) => process.stdout.write(`${line}\n`),
  server,
  sleep = wait,
  thread,
}: Config): Promise<void> => {
  const url = `${server.replace(TRAILING_SLASHES, "")}/mcp`;
  let id = 0;

  const rpc = async (method: string, params: unknown): Promise<unknown> => {
    id += 1;
    const response = await send(url, {
      body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} answered ${response.status}: ${text}`);
    }
    const message = parseRpc(response.headers.get("content-type"), text) as {
      error?: { message?: string };
      result?: unknown;
    };
    if (message.error) {
      throw new Error(`${method} failed: ${message.error.message}`);
    }
    return message.result;
  };

  const call = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const result = (await rpc("tools/call", {
      arguments: args,
      name,
    })) as ToolResult;
    if (result.isError) {
      throw new Error(`${name} failed: ${result.content?.[0]?.text}`);
    }
    return result.structuredContent ?? {};
  };

  const firstThreadId = async (): Promise<string> => {
    const listed = await call("inbox_list", {});
    const threads = (listed.threads ?? []) as unknown[];
    if (threads.length === 0) {
      throw new Error(
        "No inbox thread. Create one on the Inbox page, or pass --thread <id>."
      );
    }
    return stringField(threads[0], "id");
  };

  const { tools } = (await rpc("tools/list", {})) as {
    tools: { name: string }[];
  };
  const names = tools.map((tool) => tool.name);
  const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(`The server does not list: ${missing.join(", ")}.`);
  }
  log(`1. ${names.length} tools: ${names.sort().join(", ")}`);

  const sent = await call("send_message", {
    agent,
    requestId: `smoke-${crypto.randomUUID()}`,
    text: MESSAGE,
    waitMs: WAIT_MS,
  });
  const answer = stringField(sent, "answer");
  if (!answer.includes(MESSAGE)) {
    throw new Error(`Expected an echo of the message, got: ${answer}`);
  }
  log(`2. send_message with waitMs ${WAIT_MS} answered: ${answer}`);

  const sessionId = stringField(sent, "sessionId");
  const session = await call("read_session", { sessionId });
  if (!JSON.stringify(session).includes(answer)) {
    throw new Error("read_session does not show the answer.");
  }
  log(`3. read_session ${sessionId} shows the message and the answer`);

  const threadId = thread ?? (await firstThreadId());
  const posted = await call("inbox_post", {
    text: `@${agent} ${INBOX_MESSAGE}`,
    threadId,
  });
  const runs = (posted.runs ?? []) as unknown[];
  if (runs.length === 0) {
    throw new Error(
      `The mention started no run. The agent slug "${agent}" must exist and be active.`
    );
  }
  const runId = stringField(runs[0], "runId");
  log(`4. inbox_post to thread ${threadId} started run ${runId}`);

  const maxPolls = POLL_LIMIT_MS / POLL_MS;
  for (let poll = 0; ; poll += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each poll waits for the previous one
    const read = await call("inbox_read", { threadId });
    const posts = (read.posts ?? []) as { runId?: unknown; text?: unknown }[];
    const reply = posts.find((post) => post.runId === runId);
    if (reply) {
      log(
        `5. inbox_read shows the reply to run ${runId}: ${String(reply.text)}`
      );
      break;
    }
    if (poll >= maxPolls) {
      throw new Error(
        `No reply to run ${runId} in thread ${threadId} after ${POLL_LIMIT_MS / 1000} s.`
      );
    }
    await sleep(POLL_MS);
  }
  log("MCP smoke check passed.");
};

export const main = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { default: DEFAULT_AGENT, type: "string" },
      key: { type: "string" },
      server: { default: DEFAULT_SERVER, type: "string" },
      thread: { type: "string" },
    },
    strict: true,
  });
  if (!values.key) {
    throw new Error("Pass an API key: --key hm_key_...");
  }
  await runSmoke({
    agent: values.agent,
    key: values.key,
    server: values.server,
    thread: values.thread,
  });
};

if (import.meta.main) {
  runCli(() => main(process.argv.slice(2)));
}
