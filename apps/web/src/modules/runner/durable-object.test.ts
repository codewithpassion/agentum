import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Db } from "#/db/client";

/**
 * The runner end to end, short of a real model: a scripted `AI` binding, the
 * real workspace tools over the in-memory MCP pipe, and the real database. The
 * observable is what the router sees - the events - and what the workspace
 * sees - the message the agent posted.
 */

const storage = () => {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    alarm: () => alarm,
    api: {
      delete: (key: string) => Promise.resolve(values.delete(key)),
      deleteAll: () => {
        values.clear();
        return Promise.resolve();
      },
      get: (key: string) => Promise.resolve(values.get(key)),
      list: ({ prefix, startAfter }: { prefix: string; startAfter?: string }) =>
        Promise.resolve(
          new Map(
            [...values]
              .filter(
                ([key]) =>
                  key.startsWith(prefix) &&
                  (startAfter === undefined || key > startAfter)
              )
              .sort(([a], [b]) => (a < b ? -1 : 1)) as [string, never][]
          )
        ),
      put: (key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      },
      setAlarm: (at: number) => {
        alarm = at;
        return Promise.resolve();
      },
    },
    values,
  };
};

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  env: {},
}));

const { createDb } = await import("#/db/client");
const { createAgent } = await import("#/modules/agents/service");
const { addChannelMembers, createChannel, listChannelMessages } = await import(
  "#/modules/messaging/service"
);
const { createWorkspace } = await import("#/modules/workspaces/service");
const { AgentRunner } = await import("./durable-object");
const { MAX_MODEL_CALLS_PER_WAKE } = await import("./config");

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";

const createTestD1 = (): D1Database => {
  const dir = new URL("../../../drizzle/", import.meta.url);
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", dir), "utf8")
  ) as { entries: { tag: string }[] };
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`${entry.tag}.sql`, dir), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.exec(statement);
    }
  }
  return {
    batch: (statements: { all: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.all())),
    prepare: (query: string) => {
      const stmt = sqlite.query(query);
      return {
        bind: (...params: SQLQueryBindings[]) => ({
          all: () => Promise.resolve({ results: stmt.all(...params) }),
          raw: () => Promise.resolve(stmt.values(...params)),
          run: () => Promise.resolve(stmt.run(...params)),
        }),
      };
    },
  } as unknown as D1Database;
};

/** Chat-completions answers, handed out in order; records the requests. */
const scriptedAi = (answers: unknown[]) => {
  const requests: Record<string, unknown>[] = [];
  const ai = {
    run: (_model: string, inputs: Record<string, unknown>) => {
      requests.push(inputs);
      const next = answers.shift();
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      return Promise.resolve(next);
    },
  };
  return { ai, requests };
};

const toolCallAnswer = (name: string, args: Record<string, unknown>) => ({
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        content: "",
        tool_calls: [
          {
            function: { arguments: JSON.stringify(args), name },
            id: `call_${name}`,
            type: "function",
          },
        ],
      },
    },
  ],
});

const textAnswer = (text: string) => ({
  choices: [{ finish_reason: "stop", message: { content: text } }],
});

let db: Db;
let d1: D1Database;
let agentId: string;
let channelId: string;
let workspace: { id: string; slug: string };

const runnerFor = (
  store: ReturnType<typeof storage>,
  ai: unknown,
  overrides: Record<string, unknown> = {}
) => {
  const ctx = { storage: store.api } as unknown as DurableObjectState;
  const env = {
    AGENT_ROUTER: {
      get: () => ({ notifyMessage: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    AI: ai,
    CHANNEL_ROOM: {
      get: () => ({ broadcast: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    DB: d1,
    PUBLIC_APP_URL: "http://localhost:3720",
    ...overrides,
  } as unknown as Env;
  const runner = new AgentRunner(ctx, env);
  Object.assign(runner, { ctx, env });
  return runner;
};

/** Fires alarms while the runner keeps re-arming itself. */
const settle = async (
  runner: InstanceType<typeof AgentRunner>,
  store: ReturnType<typeof storage>,
  limit = 20
) => {
  for (let i = 0; i < limit && store.alarm() !== null; i += 1) {
    store.api.setAlarm(null as unknown as number);
    Object.assign(store, {});
    // biome-ignore lint/performance/noAwaitInLoops: alarms fire one after another
    await runner.alarm();
  }
};

const eventTypes = async (
  runner: InstanceType<typeof AgentRunner>,
  sessionId: string
) => (await runner.events(sessionId, 0)).map((event) => event.type);

beforeEach(async () => {
  d1 = createTestD1();
  db = createDb(d1);
  const created = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: ADA_ID,
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada Lovelace",
    },
  });
  workspace = { id: created.workspace.id, slug: created.workspace.slug };
  const { agent } = await createAgent(db, workspace.id, {
    instructions: "Answer briefly.",
    name: "Researcher",
    runtime: "cloudflare",
    soul: "Curious.",
  });
  agentId = agent.id;
  const channel = await createChannel(db, workspace.id, { name: "general" });
  channelId = channel.id;
  await addChannelMembers(db, channelId, [
    { memberId: agentId, memberType: "agent" },
    { memberId: ADA_ID, memberType: "user" },
  ]);
});

describe("AgentRunner", () => {
  test("runs the loop: the model posts through the real tool, then idles", async () => {
    const store = storage();
    const { ai, requests } = scriptedAi([
      toolCallAnswer("post_message", { body: "Hello from CF", channelId }),
      textAnswer("Posted."),
    ]);
    const runner = runnerFor(store, ai);

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "@Researcher say hello in #general",
    });
    expect(await runner.status("s1")).toBe("running");
    await settle(runner, store);

    expect(await runner.status("s1")).toBe("idle");
    const events = await runner.events("s1", 0);
    expect(events.map((event) => event.type)).toEqual([
      "session.status_running",
      "agent.message",
      "session.status_idle",
    ]);
    expect(events.at(-1)?.stopReason).toBe("end_turn");

    // The message really went through the workspace's own tool.
    const page = await listChannelMessages(db, workspace, {
      channelId,
      limit: 10,
    });
    expect(page.messages.map((message) => message.body)).toEqual([
      "Hello from CF",
    ]);
    expect(page.messages[0]?.authorId).toBe(agentId);

    // The model saw the system prompt, the workspace tools, and its own call.
    const [first, second] = requests;
    const wireMessages = (first?.messages ?? []) as { content: string }[];
    const system = wireMessages[0]?.content;
    expect(system).toContain("You are Researcher");
    expect(system).not.toContain("send_to_agent");
    const wireTools = (first?.tools ?? []) as { function: { name: string } }[];
    const toolNames = wireTools.map((tool) => tool.function.name);
    expect(toolNames).toContain("post_message");
    expect(toolNames).toContain("wiki_read");
    expect(toolNames).not.toContain("set_model");
    const replay = second?.messages as { role: string; content: string }[];
    expect(replay.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(replay[3]?.content).toContain("messageId");
  });

  test("events after a cursor are only the new ones", async () => {
    const store = storage();
    const runner = runnerFor(store, scriptedAi([textAnswer("Hi.")]).ai);

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "hi",
    });
    const first = await runner.events("s1", 0);
    await settle(runner, store);
    const rest = await runner.events("s1", first.at(-1)?.seq ?? 0);

    expect(first.map((event) => event.type)).toEqual([
      "session.status_running",
    ]);
    expect(rest.map((event) => event.type)).toEqual([
      "agent.message",
      "session.status_idle",
    ]);
  });

  test("a send into an idle run starts the next turn on the same transcript", async () => {
    const store = storage();
    const { ai, requests } = scriptedAi([
      textAnswer("First."),
      textAnswer("Second."),
    ]);
    const runner = runnerFor(store, ai);

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "one",
    });
    await settle(runner, store);
    await runner.send("s1", "two");
    expect(await runner.status("s1")).toBe("running");
    await settle(runner, store);

    expect(await runner.status("s1")).toBe("idle");
    const replay = requests[1]?.messages as { role: string; content: string }[];
    expect(replay.map((message) => message.content)).toEqual(
      expect.arrayContaining(["one", "First.", "two"])
    );
    expect(await eventTypes(runner, "s1")).toEqual([
      "session.status_running",
      "agent.message",
      "session.status_idle",
      "session.status_running",
      "agent.message",
      "session.status_idle",
    ]);
  });

  test("a send into a busy run is folded into the transcript at the next step", async () => {
    const store = storage();
    const { ai, requests } = scriptedAi([
      toolCallAnswer("wiki_list", {}),
      textAnswer("Done."),
    ]);
    const runner = runnerFor(store, ai);

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "go",
    });
    await runner.send("s1", "and hurry");
    await settle(runner, store);

    const replay = requests[1]?.messages as { role: string; content: string }[];
    expect(replay.at(-1)).toEqual({ content: "and hurry", role: "user" });
  });

  test("a send into an unknown or stopped session is refused", async () => {
    const store = storage();
    const runner = runnerFor(store, scriptedAi([textAnswer("Hi.")]).ai);

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "hi",
    });
    await expect(runner.send("other", "x")).rejects.toThrow(
      "no longer running"
    );
    await runner.stop("s1");
    await expect(runner.send("s1", "x")).rejects.toThrow("no longer running");
    expect(await runner.status("s1")).toBe("terminated");
    expect(await runner.status("other")).toBe("terminated");
  });

  test("a model failure is retried once, then reported as an error stop", async () => {
    const store = storage();
    const runner = runnerFor(
      store,
      scriptedAi([new Error("upstream 503"), new Error("upstream 503")]).ai
    );

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "hi",
    });
    await settle(runner, store);

    const events = await runner.events("s1", 0);
    expect(events.map((event) => event.type)).toEqual([
      "session.status_running",
      "session.error",
      "session.status_idle",
    ]);
    expect(events[1]?.text).toBe("upstream 503");
    expect(events.at(-1)?.stopReason).toBe("error");
  });

  test("a transient failure followed by success carries on", async () => {
    const store = storage();
    const runner = runnerFor(
      store,
      scriptedAi([new Error("hiccup"), textAnswer("Fine now.")]).ai
    );

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "hi",
    });
    await settle(runner, store);

    expect(await eventTypes(runner, "s1")).toEqual([
      "session.status_running",
      "agent.message",
      "session.status_idle",
    ]);
  });

  test("a wake that never stops calling tools hits the call cap", async () => {
    const store = storage();
    const answers = Array.from({ length: MAX_MODEL_CALLS_PER_WAKE + 5 }, () =>
      toolCallAnswer("wiki_list", {})
    );
    const runner = runnerFor(store, scriptedAi(answers).ai);

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "loop",
    });
    await settle(runner, store, MAX_MODEL_CALLS_PER_WAKE * 2);

    const events = await runner.events("s1", 0);
    expect(events.at(-1)?.type).toBe("session.status_idle");
    expect(events.at(-1)?.stopReason).toBe("max_model_calls");
  });

  test("without the AI binding the run fails with a clear message", async () => {
    const store = storage();
    const runner = runnerFor(store, undefined);

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "hi",
    });
    await settle(runner, store);

    const events = await runner.events("s1", 0);
    expect(events[1]?.type).toBe("session.error");
    expect(events[1]?.text).toContain("Workers AI binding");
  });

  test("a stop lands between steps", async () => {
    const store = storage();
    const runner = runnerFor(
      store,
      scriptedAi([toolCallAnswer("wiki_list", {}), textAnswer("never")]).ai
    );

    await runner.start({
      agentId,
      model: "@cf/test",
      sessionId: "s1",
      text: "go",
    });
    await runner.stop("s1");
    await settle(runner, store);

    expect(await runner.status("s1")).toBe("terminated");
    expect(await eventTypes(runner, "s1")).toEqual([
      "session.status_running",
      "session.status_terminated",
    ]);
  });
});
