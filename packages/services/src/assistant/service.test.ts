// biome-ignore-all lint/performance/noAwaitInLoops: Scripted turns and database assertions run in order.
import { expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import {
  assistantConversations,
  assistantMessages,
} from "@repo/db/schema/assistant";
import { migrated } from "@repo/db/test-db";
import { assistantCardTools } from "@repo/mcp/assistant";
import type { ToolDefinition } from "@repo/mcp/tools/define";
import { createMasker } from "@repo/protocol/masker";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { NO_KEY_MESSAGE } from "../managed/keys";
import type { Principal } from "../workspaces";
import { type AssistantDeps, createAssistantService } from "./service";

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
  key = true,
  overrides: Partial<AssistantDeps> = {}
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
    modelKeyStatus: async () => ({ configured: true }),
    secrets: {
      describe: async () => ({
        allowedHosts: ["stored.example"],
        grantedTo: ["agent_stored"],
        id: "s1",
        mode: "env",
        name: "TOKEN",
      }),
    },
    tools: () => [...tools, ...assistantCardTools],
    ...overrides,
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
    await expect(f.service.send(user, { text })).rejects.toMatchObject({
      message: expect.stringContaining("That looks like a key"),
      reason: "key_in_message",
    });
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
  const results = await Promise.allSettled([
    f.service.resolveCard(user, input),
    f.service.resolveCard(user, input),
  ]);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1
  );
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

test("send and card resolution exclude each other for the whole turn", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = fixture([[call("change")]], [], true, {
    fetch: async () => {
      if (!chatId) {
        return Response.json({ content: [call("change")] });
      }
      entered.resolve();
      await release.promise;
      return Response.json({ content: answer });
    },
  });
  let chatId: string | undefined;
  const chat = await f.service.send(user, { text: "Change it" });
  chatId = chat.id;
  const resolving = f.service.resolveCard(user, {
    conversationId: chat.id,
    outcome: { run: true },
    toolUseId: "tool_1",
  });
  await entered.promise;
  const contenders = Promise.allSettled([
    f.service.send(user, { conversationId: chat.id, text: "Skip it" }),
    f.service.resolveCard(user, {
      conversationId: chat.id,
      outcome: { run: false },
      toolUseId: "tool_1",
    }),
  ]);
  // Let both requests reach the held lease before allowing the model to finish.
  await new Promise((resolve) => setTimeout(resolve, 0));
  release.resolve();
  await resolving;
  for (const result of await contenders) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason.message).toContain("still working");
    }
  }
  const stored = await f.service.get(user, chat.id);
  expect(
    stored.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result")
  ).toHaveLength(1);
  f.db.client.close();
});

test("workspace secret guesses are accepted as ordinary messages", async () => {
  const f = fixture([answer]);
  await f.service.send(user, { text: "Is private-value-123 the value?" });
  expect(f.received).toHaveLength(1);
  f.db.client.close();
});

test("key shaped card metadata is refused before it is stored", async () => {
  const f = fixture([
    [call("request_secret", { mode: "env", name: "TOKEN", reason: "Needed" })],
  ]);
  const chat = await f.service.send(user, { text: "Set access" });
  await expect(
    f.service.resolveCard(user, {
      conversationId: chat.id,
      outcome: {
        grantedTo: [],
        hosts: ["ghp_abcdef123456"],
        mode: "env",
        name: "TOKEN",
        saved: true,
        secretId: "s1",
      },
      toolUseId: "tool_1",
    })
  ).rejects.toThrow("looks like a key");
  expect(JSON.stringify(await f.service.get(user, chat.id))).not.toContain(
    "ghp_abcdef123456"
  );
  f.db.client.close();
});

test("one masker is reused throughout a tool loop", async () => {
  let masks = 0;
  const f = fixture(
    [[call("read")], answer],
    [
      {
        annotations: { readOnlyHint: true },
        description: "Read",
        inputSchema: z.strictObject({}),
        name: "read",
        run: async () => ({ data: {}, text: "ok" }),
        title: "Read",
      },
    ],
    true,
    {
      masker: () => {
        masks += 1;
        return Promise.resolve(createMasker({}));
      },
    }
  );
  await f.service.send(user, { text: "Read" });
  expect(masks).toBe(1);
  f.db.client.close();
});

test("saved secret results come from storage and must match the card", async () => {
  for (const stored of [
    null,
    {
      allowedHosts: [],
      grantedTo: [],
      id: "s1",
      mode: "env" as const,
      name: "OTHER",
    },
    {
      allowedHosts: ["stored.example"],
      grantedTo: ["agent_stored"],
      id: "s1",
      mode: "proxy" as const,
      name: "TOKEN",
    },
  ]) {
    const f = fixture(
      [
        [
          call("request_secret", {
            mode: "env",
            name: "TOKEN",
            reason: "Needed",
          }),
        ],
        answer,
      ],
      [],
      true,
      { secrets: { describe: async () => stored } }
    );
    const chat = await f.service.send(user, { text: "Set access" });
    const resolving = f.service.resolveCard(user, {
      conversationId: chat.id,
      outcome: {
        grantedTo: ["forged"],
        hosts: ["forged.example"],
        mode: "env",
        name: "TOKEN",
        saved: true,
        secretId: "s1",
      },
      toolUseId: "tool_1",
    });
    if (stored?.name === "TOKEN") {
      await resolving;
      expect(JSON.stringify(f.received)).toContain("agent_stored");
      expect(JSON.stringify(f.received)).not.toContain("forged");
    } else {
      await expect(resolving).rejects.toThrow();
      expect((await f.service.get(user, chat.id)).pendingCard).not.toBeNull();
    }
    f.db.client.close();
  }
});

test("a model key save requires the card provider to be configured", async () => {
  for (const provider of ["anthropic", "openrouter"] as const) {
    const f = fixture(
      [
        [
          call("request_model_key", {
            provider: "openrouter",
            reason: "Needed",
          }),
        ],
      ],
      [],
      true,
      { modelKeyStatus: async () => ({ configured: false }) }
    );
    const chat = await f.service.send(user, { text: "Set provider" });
    await expect(
      f.service.resolveCard(user, {
        conversationId: chat.id,
        outcome: { provider, saved: true },
        toolUseId: "tool_1",
      })
    ).rejects.toThrow();
    expect((await f.service.get(user, chat.id)).pendingCard).not.toBeNull();
    f.db.client.close();
  }
});

test("retry recovers an interrupted confirm without executing it again", async () => {
  const f = fixture([[call("change")], answer]);
  const chat = await f.service.send(user, { text: "Change it" });
  await f.db.insert(assistantMessages).values({
    content: [
      {
        content: JSON.stringify({ run: true, status: "resolving" }),
        tool_use_id: "tool_1",
        type: "tool_result",
      },
    ],
    conversationId: chat.id,
    createdAt: "2026-11-05T00:00:00Z",
    id: `card:${chat.id}:tool_1`,
    role: "user",
    seq: 2,
    workspaceId: "ws_a",
  });
  const recovered = await f.service.resolveCard(user, {
    conversationId: chat.id,
    outcome: { run: true },
    toolUseId: "tool_1",
  });
  expect(f.runs()).toBe(0);
  expect(f.received).toHaveLength(2);
  expect(JSON.stringify(recovered)).not.toContain("resolving");
  expect(JSON.stringify(recovered)).toContain("interrupted");
  f.db.client.close();
});

test("an expired lease is reclaimable and the stale Worker cannot write or release the new lease", async () => {
  let time = new Date("2026-11-05T00:00:00Z").getTime();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const f = fixture([], [], true, {
    clock: { now: () => new Date(time) },
    fetch: async () => {
      calls += 1;
      if (calls === 2) {
        entered.resolve();
        await release.promise;
        return Response.json({
          content: [{ text: "stale reply", type: "text" }],
        });
      }
      return Response.json({ content: answer });
    },
  });
  const chat = await f.service.send(user, { text: "Hello" });
  const stale = f.service.send(user, {
    conversationId: chat.id,
    text: "Continue",
  });
  const staleFailure = stale.catch((error: unknown) => error);
  await entered.promise;
  time += 6 * 60_000;
  await f.service.send(user, { conversationId: chat.id, text: "Recover" });
  release.resolve();
  expect(await staleFailure).toMatchObject({
    message: "The assistant turn expired. Try again.",
  });
  expect(JSON.stringify(await f.service.get(user, chat.id))).not.toContain(
    "stale reply"
  );
  const [row] = await f.db
    .select()
    .from(assistantConversations)
    .where(eq(assistantConversations.id, chat.id));
  expect(row?.busyUntil).toBeNull();
  f.db.client.close();
});

test("database rejects a second result for a tool use even with a different message id", async () => {
  const f = fixture([[call("change")], answer]);
  const chat = await f.service.send(user, { text: "Change" });
  await f.service.resolveCard(user, {
    conversationId: chat.id,
    outcome: { run: false },
    toolUseId: "tool_1",
  });
  const [result] = (await f.db.select().from(assistantMessages)).filter(
    (row) => row.toolUseId === "tool_1"
  );
  if (!result) {
    throw new Error("Result was not stored");
  }
  expect(() =>
    f.db
      .insert(assistantMessages)
      .values({ ...result, id: "duplicate", seq: 100 })
      .run()
  ).toThrow();
  f.db.client.close();
});

test("card outcome arrays are bounded", async () => {
  const f = fixture([
    [call("request_secret", { mode: "env", name: "TOKEN", reason: "Needed" })],
  ]);
  const chat = await f.service.send(user, { text: "Set access" });
  for (const field of ["hosts", "grantedTo"]) {
    await expect(
      f.service.resolveCard(user, {
        conversationId: chat.id,
        outcome: {
          grantedTo: [],
          hosts: [],
          mode: "env",
          name: "TOKEN",
          saved: true,
          secretId: "s1",
          [field]: new Array(101).fill("example"),
        },
        toolUseId: "tool_1",
      })
    ).rejects.toThrow();
  }
  f.db.client.close();
});

const seedConversation = (
  f: ReturnType<typeof fixture>,
  id: string,
  title: string,
  updatedAt: string,
  messages = 0
) => {
  f.db
    .insert(assistantConversations)
    .values({
      createdAt: updatedAt,
      id,
      title,
      updatedAt,
      userId: "u1",
      workspaceId: "ws_a",
    })
    .run();
  for (let seq = 0; seq < messages; seq += 1) {
    f.db
      .insert(assistantMessages)
      .values({
        content: [{ text: `message ${seq}`, type: "text" }],
        conversationId: id,
        createdAt: updatedAt,
        id: `${id}_m${seq}`,
        role: seq % 2 === 0 ? "user" : "assistant",
        seq,
        workspaceId: "ws_a",
      })
      .run();
  }
};

test("list pages by activity, takes a title search, and caps a page at 50", async () => {
  const f = fixture([]);
  for (let index = 0; index < 55; index += 1) {
    seedConversation(
      f,
      `c${String(index).padStart(2, "0")}`,
      index === 3 ? "Quarterly 100% plan" : `Chat ${index}`,
      `2026-11-01T00:${String(index).padStart(2, "0")}:00Z`
    );
  }
  const first = await f.service.list(user);
  expect(first).toHaveLength(50);
  expect(first[0]?.id).toBe("c54");
  const rest = await f.service.list(user, { cursor: first.at(-1)?.cursor });
  expect(rest.map((item) => item.id)).toEqual([
    "c04",
    "c03",
    "c02",
    "c01",
    "c00",
  ]);
  expect(await f.service.list(user, { limit: 2 })).toHaveLength(2);
  expect(
    (await f.service.list(user, { query: "100%" })).map((item) => item.id)
  ).toEqual(["c03"]);
  await expect(f.service.list(user, { cursor: "nonsense" })).rejects.toThrow();
  f.db.client.close();
});

test("get returns the newest 50 messages and pages back with before", async () => {
  const f = fixture([]);
  seedConversation(f, "long", "Long one", "2026-11-01T00:00:00Z", 120);
  const newest = await f.service.get(user, "long");
  expect(newest.messages).toHaveLength(50);
  expect(newest.messages[0]?.seq).toBe(70);
  expect(newest.messages.at(-1)?.seq).toBe(119);
  expect(newest.hasEarlier).toBe(true);
  const middle = await f.service.get(user, "long", { before: 70 });
  expect(middle.messages.map((message) => message.seq)).toEqual(
    Array.from({ length: 50 }, (_, index) => 20 + index)
  );
  expect(middle.pendingCard).toBeNull();
  const oldest = await f.service.get(user, "long", { before: 20 });
  expect(oldest.messages).toHaveLength(20);
  expect(oldest.hasEarlier).toBe(false);
  seedConversation(f, "short", "Short one", "2026-11-01T00:00:00Z", 2);
  expect((await f.service.get(user, "short")).hasEarlier).toBe(false);
  f.db.client.close();
});
