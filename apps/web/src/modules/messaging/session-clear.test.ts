import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import type { Db } from "#/db/client";

/**
 * The session divider and `/clear`: which agents a request resets, who may ask,
 * and what lands in the conversation.
 */

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

let signedInAs: string | null = null;
mock.module("@clerk/hono", () => ({
  getAuth: () => (signedInAs ? { userId: signedInAs } : null),
}));

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const BOB_ID = "user_2bBobBBBBBBBBBBBBBBBBBBB";

const { createDb } = await import("#/db/client");
const { createAgent } = await import("#/modules/agents/service");
const { resetAgentSession } = await import("#/modules/agents/session-reset");
const { workspaceScopedRoutes } = await import("#/modules/workspaces/routes");
const { addMember, createWorkspace } = await import(
  "#/modules/workspaces/service"
);
const { channelsRoutes } = await import("./routes/channels");
const { addChannelMembers, createChannel, getOrCreateAgentDm } = await import(
  "./service"
);
const { getLatestSessionStart, windowSinceDivider } = await import(
  "./session-divider"
);
const { listChannelMessages } = await import("./service");

const migrationsDir = new URL("../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrationsDir), "utf8")
  ) as { entries: { tag: string }[] };
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const entry of journal.entries) {
    const sql = readFileSync(
      new URL(`${entry.tag}.sql`, migrationsDir),
      "utf8"
    );
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

workspaceScopedRoutes.route("/channels", channelsRoutes);
const app = new Hono<ApiEnv>();
app.route("/api/w/:workspaceSlug", workspaceScopedRoutes);

let db: Db;
let env: Env;
let workspace: { id: string; slug: string };
let ada: { id: string; name: string; workspaceId: string };
let grace: { id: string; name: string; workspaceId: string };
let roomChannelId: string;
let retired: string[];
let notified: number;
let broadcasts: string[];

const clear = (
  channelId: string,
  body: unknown,
  as: string = ADA_ID
): Promise<Response> => {
  signedInAs = as;
  return Promise.resolve(
    app.request(
      `/api/w/${workspace.slug}/channels/${channelId}/clear`,
      {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      env
    )
  );
};

const dividersIn = async (channelId: string) =>
  (await listChannelMessages(db, workspace, { channelId, limit: 50 })).messages
    .filter((message) => message.origin === "session_start")
    .map((message) => message.body)
    .sort();

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1);
  retired = [];
  notified = 0;
  broadcasts = [];
  env = {
    AGENT_ROUTER: {
      get: () => ({
        notifyMessage: () => {
          notified += 1;
          return Promise.resolve();
        },
        retireSession: (agentId: string) => {
          retired.push(agentId);
          return Promise.resolve({ retired: true });
        },
      }),
      idFromName: (name: string) => name,
    },
    CHANNEL_ROOM: {
      get: () => ({
        broadcast: (payload: string) => {
          broadcasts.push(payload);
          return Promise.resolve();
        },
      }),
      idFromName: (name: string) => name,
    },
    DB: d1,
  } as unknown as Env;

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
  await addMember(db, workspace.id, {
    clerkUserId: BOB_ID,
    email: "bob@example.com",
    imageUrl: null,
    name: "Bob Barker",
    role: "member",
  });
  const first = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Researcher",
    soul: "",
  });
  const second = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Writer",
    soul: "",
  });
  ada = first.agent;
  grace = second.agent;
  const room = await createChannel(db, workspace.id, { name: "ops" });
  roomChannelId = room.id;
  await addChannelMembers(db, room.id, [
    { memberId: ADA_ID, memberType: "user" },
    { memberId: ada.id, memberType: "agent" },
    { memberId: grace.id, memberType: "agent" },
  ]);
});

describe("POST /channels/:id/clear", () => {
  test("in a DM, resets that DM's agent and marks the DM", async () => {
    const dm = await getOrCreateAgentDm(db, ada, ADA_ID);

    const response = await clear(dm.id, {});

    expect(response.status).toBe(200);
    expect(retired).toEqual([ada.id]);
    expect(await dividersIn(dm.id)).toEqual([
      "New session started for Researcher.",
    ]);
    expect(
      broadcasts.some((payload) => payload.includes('"session_start"'))
    ).toBe(true);
  });

  test("in a channel, resets every agent member", async () => {
    const response = await clear(roomChannelId, {});
    const body = (await response.json()) as {
      reset: { agentId: string; retired: boolean }[];
    };

    expect(response.status).toBe(200);
    expect(body.reset.map((entry) => entry.agentId).sort()).toEqual(
      [ada.id, grace.id].sort()
    );
    expect(retired.sort()).toEqual([ada.id, grace.id].sort());
    expect(await dividersIn(roomChannelId)).toEqual([
      "New session started for Researcher.",
      "New session started for Writer.",
    ]);
  });

  test("with agentIds, resets just that agent", async () => {
    const response = await clear(roomChannelId, { agentIds: [grace.id] });

    expect(response.status).toBe(200);
    expect(retired).toEqual([grace.id]);
    expect(await dividersIn(roomChannelId)).toEqual([
      "New session started for Writer.",
    ]);
  });

  test("refuses an agent that is not in the channel", async () => {
    const stranger = await createAgent(db, workspace.id, {
      instructions: "",
      name: "Outsider",
      soul: "",
    });

    const response = await clear(roomChannelId, {
      agentIds: [stranger.agent.id],
    });

    expect(response.status).toBe(400);
    expect(retired).toEqual([]);
    expect(await dividersIn(roomChannelId)).toEqual([]);
  });

  test("one agent failing does not stop the others, and each reports", async () => {
    const original = env.AGENT_ROUTER.get;
    (env.AGENT_ROUTER as { get: unknown }).get = (...args: never[]) => {
      const stub = (original as (...a: never[]) => Record<string, unknown>)(
        ...args
      );
      return {
        ...stub,
        retireSession: (agentId: string) =>
          agentId === ada.id
            ? Promise.reject(new Error("router down"))
            : (stub.retireSession as (id: string) => Promise<unknown>)(agentId),
      };
    };

    const response = await clear(roomChannelId, {});
    const body = (await response.json()) as {
      reset: { agentId: string; error?: string }[];
    };

    expect(response.status).toBe(200);
    expect(body.reset.find((r) => r.agentId === ada.id)?.error).toBe(
      "router down"
    );
    expect(
      body.reset.find((r) => r.agentId === grace.id)?.error
    ).toBeUndefined();
    expect(retired).toEqual([grace.id]);
  });

  test("refuses a member who is not an owner", async () => {
    const response = await clear(roomChannelId, {}, BOB_ID);

    expect(response.status).toBe(403);
    expect(retired).toEqual([]);
    expect(await dividersIn(roomChannelId)).toEqual([]);
  });

  test("a divider wakes nobody", async () => {
    await clear(roomChannelId, {});
    expect(notified).toBe(0);
  });
});

describe("resetAgentSession", () => {
  test("the button path marks the agent's DM", async () => {
    const dm = await getOrCreateAgentDm(db, ada, ADA_ID);

    const result = await resetAgentSession(db, env, workspace, ada as never);

    expect(result).toEqual({ retired: true });
    expect(await dividersIn(dm.id)).toEqual([
      "New session started for Researcher.",
    ]);
  });

  test("posts nothing when the agent has no DM and no channel is given", async () => {
    await resetAgentSession(db, env, workspace, ada as never);
    expect(await dividersIn(roomChannelId)).toEqual([]);
    expect(retired).toEqual([ada.id]);
  });

  test("getLatestSessionStart finds the newest divider per agent", async () => {
    await clear(roomChannelId, { agentIds: [ada.id] });
    await clear(roomChannelId, { agentIds: [grace.id] });

    const mine = await getLatestSessionStart(db, roomChannelId, ada.id);
    const theirs = await getLatestSessionStart(db, roomChannelId, grace.id);
    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    expect(mine?.id).not.toBe(theirs?.id);
    expect(
      await getLatestSessionStart(db, roomChannelId, "agent_unknown")
    ).toBeNull();
  });
});

describe("windowSinceDivider", () => {
  const page = [{ id: "c" }, { id: "d" }, { id: "b" }, { id: "a" }];

  test("cuts a newest-first page at the divider, keeping it", () => {
    expect(windowSinceDivider(page, "d")).toEqual({
      messages: [{ id: "c" }, { id: "d" }],
      reached: true,
    });
  });

  test("leaves a page that never reaches the divider alone", () => {
    expect(windowSinceDivider(page, "zzz")).toEqual({
      messages: page,
      reached: false,
    });
  });
});
