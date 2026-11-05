// biome-ignore-all lint/performance/noAwaitInLoops: Scripted turns and database assertions run in order.
import { expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { assistantMessages } from "@repo/db/schema/assistant";
import { migrated } from "@repo/db/test-db";
import { assistantCardTools } from "@repo/mcp/assistant";
import type { ToolDefinition } from "@repo/mcp/tools/define";
import { createMasker } from "@repo/protocol/masker";
import { z } from "zod";
import { NO_KEY_MESSAGE } from "../managed/keys";
import type { Principal } from "../workspaces";
import { createAssistantService } from "./service";

const user: Principal = {
  isAdmin: true,
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "ws_a",
};
const call = (name: string, input = {}, id = "tool_1") => ({
  id,
  input,
  name,
  type: "tool_use",
});
const answer = [{ text: "Done", type: "text" }];
const fixture = (
  replies: unknown[][],
  tools: ToolDefinition[] = [],
  key = true
) => {
  const db = migrated(["a", "b"]);
  const received: unknown[] = [];
  let runs = 0;
  const service = createAssistantService({
    atomic: sqliteAtomic(db),
    clock: { now: () => new Date("2026-11-05T00:00:00Z") },
    db,
    fetch: (_input, init) => {
      received.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        Response.json({ content: replies.shift() ?? answer })
      );
    },
    managedKeys: {
      resolve: async () =>
        key ? { apiKey: "model-key", environmentId: null } : null,
    },
    masker: async () => createMasker({ TEST: "private-value-123" }),
    tools: () => [...tools, ...assistantCardTools],
  });
  const tool: ToolDefinition = {
    annotations: { destructiveHint: true },
    description: "Change",
    inputSchema: z.strictObject({}),
    name: "change",
    run: () => {
      runs += 1;
      return Promise.resolve({ data: {}, text: "private-value-123" });
    },
    title: "Change",
  };
  tools.push(tool);
  return { db, received, runs: () => runs, service };
};

test("destructive tools pause, run or decline, scrub results, and resolve once", async () => {
  for (const run of [true, false]) {
    const f = fixture([[call("change")], answer]);
    const chat = await f.service.send(user, { text: "Change it" });
    expect(f.runs()).toBe(0);
    expect(chat.pendingCard?.toolUseId).toBe("tool_1");
    const input = {
      conversationId: chat.id,
      outcome: { run },
      toolUseId: "tool_1",
    };
    await f.service.resolveCard(user, input);
    const before = f.received.length;
    await f.service.resolveCard(user, input);
    expect(f.received.length).toBe(before);
    expect(f.runs()).toBe(run ? 1 : 0);
    expect(JSON.stringify(f.received)).not.toContain("private-value-123");
    expect(
      JSON.stringify(await f.db.select().from(assistantMessages))
    ).not.toContain("private-value-123");
    f.db.client.close();
  }
});

test("secret cards stop, accept only metadata, decline with guidance, and refuse repeats in a turn", async () => {
  for (const saved of [true, false]) {
    const f = fixture([
      [
        call("request_secret", {
          mode: "env",
          name: "TOKEN",
          reason: "Needed",
        }),
      ],
      [
        call(
          "request_secret",
          { mode: "env", name: "TOKEN", reason: "Again" },
          "tool_2"
        ),
      ],
      answer,
    ]);
    const chat = await f.service.send(user, { text: "Set up access" });
    expect(chat.pendingCard?.kind).toBe("secret");
    const result = await f.service.resolveCard(user, {
      conversationId: chat.id,
      outcome: saved
        ? {
            grantedTo: [],
            hosts: [],
            mode: "env",
            name: "TOKEN",
            saved: true,
            secretId: "s1",
          }
        : { reason: "declined", saved: false },
      toolUseId: "tool_1",
    });
    expect(result.pendingCard).toBeNull();
    expect(JSON.stringify(f.received)).toContain("already requested");
    if (!saved) {
      expect(JSON.stringify(f.received)).toContain("The person declined");
    }
    expect(
      JSON.stringify(await f.db.select().from(assistantMessages))
    ).not.toContain("private-value-123");
    f.db.client.close();
  }
});

test("key shaped messages store nothing; ordinary long words pass", async () => {
  const f = fixture([answer]);
  for (const text of [
    "sk-ant-abcdef123456",
    "ghp_abcdef123456",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    "sk-abcdef123456",
    "AKIA1234567890ABCDEF",
    "aB9xQ7mN2vR8tL4zW6pY3kF5sH0dJ1cE",
    "rulvszmkeyctbnxdqwfohajipugxevzcrtmnskylbq",
    "b3a0e74c9f2185d6a8e0b2d4c6f901734be28f50a9d61c03e7f48a52b960dc13",
    "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
  ]) {
    await expect(f.service.send(user, { text })).rejects.toThrow(
      "That looks like a key"
    );
  }
  expect(await f.db.select().from(assistantMessages)).toHaveLength(0);
  await f.service.send(user, {
    text: "pneumonoultramicroscopicsilicovolcanoconiosis",
  });
  expect(f.received).toHaveLength(1);
  f.db.client.close();
});

test("private conversations enforce both owner and workspace, including archived reads", async () => {
  const f = fixture([answer]);
  const chat = await f.service.send(user, { text: "Hello" });
  for (const stranger of [
    { ...user, userId: "u2" },
    { ...user, workspaceId: "ws_b" },
  ]) {
    expect(await f.service.list(stranger)).toEqual([]);
    await expect(f.service.get(stranger, chat.id)).rejects.toThrow();
    await expect(
      f.service.send(stranger, { conversationId: chat.id, text: "Hello" })
    ).rejects.toThrow();
    await expect(f.service.archive(stranger, chat.id)).rejects.toThrow();
    await expect(
      f.service.resolveCard(stranger, {
        conversationId: chat.id,
        outcome: { run: true },
        toolUseId: "tool_1",
      })
    ).rejects.toThrow();
  }
  await f.service.archive(user, chat.id);
  expect(await f.service.list(user)).toEqual([]);
  expect((await f.service.get(user, chat.id)).archivedAt).not.toBeNull();
  f.db.client.close();
});

test("no key returns the builder message without a model call", async () => {
  const f = fixture([], [], false);
  const chat = await f.service.send(user, { text: "Hello" });
  expect(JSON.stringify(chat)).toContain(NO_KEY_MESSAGE);
  expect(f.received).toHaveLength(0);
  f.db.client.close();
});

test("the turn stops at sixteen calls, including across cards", async () => {
  const f = fixture(
    Array.from({ length: 17 }, (_, i) => [call("read", {}, `tool_${i}`)]),
    [
      {
        annotations: { readOnlyHint: true },
        description: "Read",
        inputSchema: z.strictObject({}),
        name: "read",
        run: async () => ({ data: {}, text: "ok" }),
        title: "Read",
      },
    ]
  );
  const chat = await f.service.send(user, { text: "Read" });
  expect(f.received).toHaveLength(16);
  expect(JSON.stringify(chat)).toContain("16 tool calls");
  f.db.client.close();
});

test("concurrent card retries execute a destructive operation once", async () => {
  const f = fixture([[call("change")], answer]);
  const chat = await f.service.send(user, { text: "Change it" });
  const input = {
    conversationId: chat.id,
    outcome: { run: true },
    toolUseId: "tool_1",
  };
  await Promise.all([
    f.service.resolveCard(user, input),
    f.service.resolveCard(user, input),
  ]);
  expect(f.runs()).toBe(1);
  f.db.client.close();
});

test("open cards survive reads and a new message cancels them before continuing", async () => {
  const f = fixture([
    [call("request_secret", { mode: "env", name: "TOKEN", reason: "Needed" })],
    answer,
  ]);
  const chat = await f.service.send(user, { text: "Set access" });
  expect((await f.service.get(user, chat.id)).pendingCard?.kind).toBe("secret");
  const next = await f.service.send(user, {
    conversationId: chat.id,
    text: "Skip that",
  });
  expect(next.pendingCard).toBeNull();
  expect(JSON.stringify(f.received)).toContain("cancelled");
  await expect(
    f.service.resolveCard(user, {
      conversationId: chat.id,
      outcome: { saved: true, value: "private-value-123" },
      toolUseId: "tool_1",
    } as never)
  ).rejects.toThrow();
  f.db.client.close();
});

test("a failed completion retains earlier steps and a readable error", async () => {
  const f = fixture(
    [[call("read")], []],
    [
      {
        annotations: { readOnlyHint: true },
        description: "Read",
        inputSchema: z.strictObject({}),
        name: "read",
        run: async () => ({ data: {}, text: "ok" }),
        title: "Read",
      },
    ]
  );
  const chat = await f.service.send(user, { text: "Read it" });
  expect(JSON.stringify(chat)).toContain("could not finish");
  expect(JSON.stringify(chat)).toContain("tool_result");
  f.db.client.close();
});

test("secret-bearing tool results reach neither the model, stored messages nor console logs", async () => {
  const spies = [
    spyOn(console, "log"),
    spyOn(console, "warn"),
    spyOn(console, "error"),
    spyOn(console, "info"),
  ];
  for (const spy of spies) {
    spy.mockImplementation(() => undefined);
  }
  const f = fixture([[call("change")], answer]);
  try {
    const chat = await f.service.send(user, { text: "Change it" });
    await f.service.resolveCard(user, {
      conversationId: chat.id,
      outcome: { run: true },
      toolUseId: "tool_1",
    });
    for (const value of [
      f.received,
      await f.db.select().from(assistantMessages),
      spies.map((spy) => spy.mock.calls),
    ]) {
      expect(JSON.stringify(value)).not.toContain("private-value-123");
    }
    expect(JSON.stringify(f.received)).toContain("[secret:TEST]");
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
    f.db.client.close();
  }
});

test("model key cards save or decline using metadata only", async () => {
  for (const saved of [true, false]) {
    const f = fixture([
      [
        call("request_model_key", {
          provider: "openrouter",
          reason: "Needed for the agent",
        }),
      ],
      answer,
    ]);
    const chat = await f.service.send(user, { text: "Set the model provider" });
    expect(chat.pendingCard?.kind).toBe("model_key");
    const next = await f.service.resolveCard(user, {
      conversationId: chat.id,
      outcome: saved
        ? { provider: "openrouter", saved: true }
        : { reason: "declined", saved: false },
      toolUseId: "tool_1",
    });
    expect(next.pendingCard).toBeNull();
    expect(f.received).toHaveLength(2);
    f.db.client.close();
  }
});

test("the sixteen-call budget survives a card pause", async () => {
  const f = fixture(
    [
      Array.from({ length: 15 }, (_, i) => call("read", {}, `read_${i}`)),
      [
        call("request_secret", {
          mode: "env",
          name: "TOKEN",
          reason: "Needed",
        }),
      ],
    ],
    [
      {
        annotations: { readOnlyHint: true },
        description: "Read",
        inputSchema: z.strictObject({}),
        name: "read",
        run: async () => ({ data: {}, text: "ok" }),
        title: "Read",
      },
    ]
  );
  const chat = await f.service.send(user, {
    text: "Read things and configure access",
  });
  expect(chat.pendingCard?.kind).toBe("secret");
  const next = await f.service.resolveCard(user, {
    conversationId: chat.id,
    outcome: { reason: "declined", saved: false },
    toolUseId: "tool_1",
  });
  expect(JSON.stringify(next)).toContain("16 tool calls");
  expect(f.received).toHaveLength(2);
  f.db.client.close();
});
