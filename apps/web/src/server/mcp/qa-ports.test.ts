import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { createHarbourmasterMcpServer } from "@repo/mcp/server";
import { connectClient } from "@repo/mcp/testing";
import { isReadOnly } from "@repo/services/automation-access";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { QA_LIST_LIMIT } from "@repo/services/qa";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { type Composed, composeWith } from "../compose.ts";
import { createMcpPorts } from "./ports.ts";
import { createQaPorts } from "./qa-ports.ts";

let composed: Composed;
let user: Principal;
let readKey: Principal;

beforeEach(async () => {
  const db = migrated();
  const store = new Map<string, string>();
  composed = composeWith({
    allowedOrgIds: ["org_a"],
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      clock: { now: () => new Date(), sleep: systemClock.sleep },
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("the test organisation is not allowed");
  }
  user = {
    kind: "user",
    userId: "user_1",
    via: "session",
    workspaceId: workspace.id,
  };
  readKey = {
    apiKey: { access: "read", id: "key_1" },
    kind: "user",
    userId: "user_1",
    via: "api_key",
    workspaceId: workspace.id,
  };
});

/** An MCP session for `principal` with the Q&A tools on. */
const connect = async (principal: Principal) => {
  const ports = createMcpPorts({ principal, services: composed.services });
  const { client, close } = await connectClient(
    createHarbourmasterMcpServer(ports, {
      qa: true,
      readOnly: isReadOnly(principal),
    })
  );
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ arguments: args, name });
      return {
        data: (result.structuredContent ?? {}) as Record<string, unknown>,
        isError: result.isError === true,
      };
    },
    close,
  };
};

test("a question asked through the port is read, answered and listed with the tools' ids", async () => {
  const session = await connect(user);
  try {
    const asked = await session.call("qa_ask", {
      body: "Which environment?",
      title: "Environment",
    });
    expect(asked.isError).toBe(false);
    const id = asked.data.id as string;
    expect(asked.data).toMatchObject({
      authorId: "user_1",
      authorKind: "user",
      status: "open",
      title: "Environment",
    });
    expect(asked.data).not.toHaveProperty("workspaceId");

    const answered = await session.call("qa_answer", {
      body: "Use staging.",
      id,
    });
    expect(answered.isError).toBe(false);
    expect(answered.data).toMatchObject({
      body: "Use staging.",
      questionId: id,
    });
    expect(answered.data).not.toHaveProperty("workspaceId");

    const read = await session.call("qa_read", { id });
    expect(read.isError).toBe(false);
    expect(read.data.question).toMatchObject({ id, title: "Environment" });
    expect(read.data.answers).toHaveLength(1);

    const listed = await session.call("qa_list", { status: "open" });
    expect(listed.data.nextCursor).toBeNull();
    expect(listed.data.questions).toHaveLength(1);
  } finally {
    await session.close();
  }
});

test("qa_list pages through the board with the cursor", async () => {
  for (let n = 0; n < QA_LIST_LIMIT + 1; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Questions are asked in order so their ids sort.
    await composed.services.qa.ask(user, { body: "b", title: `Q${n}` });
  }
  const session = await connect(user);
  try {
    const first = await session.call("qa_list", {});
    const firstPage = first.data.questions as { id: string }[];
    expect(firstPage).toHaveLength(QA_LIST_LIMIT);
    expect(first.data.nextCursor).toBe(firstPage.at(-1)?.id);

    const second = await session.call("qa_list", {
      cursor: first.data.nextCursor,
    });
    expect(second.data.questions).toHaveLength(1);
    expect(second.data.nextCursor).toBeNull();
  } finally {
    await session.close();
  }
});

test("an unknown question is not_found", async () => {
  const session = await connect(user);
  try {
    const result = await session.call("qa_read", { id: "nope" });
    expect(result.isError).toBe(true);
    expect(result.data.code).toBe("not_found");
  } finally {
    await session.close();
  }
});

test("a read-only key reads the board and its writes are refused", async () => {
  const question = await composed.services.qa.ask(user, {
    body: "b",
    title: "Shared",
  });
  const qa = createQaPorts({
    principal: readKey,
    services: composed.services,
  });
  // The port itself refuses a write, whatever the tool registration does.
  await expect(qa.answer({ body: "x", id: question.id })).rejects.toMatchObject(
    { code: "forbidden" }
  );
  const read = await qa.get({ id: question.id });
  expect(read.question.title).toBe("Shared");
});
