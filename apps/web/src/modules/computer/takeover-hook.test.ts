import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb } from "#/db/client";

/**
 * Handing a desktop back and declining a takeover, against the shipped
 * migrations. The race is the point: two hand-backs read the same pending row,
 * and the conditional update lets exactly one of them post the reply that wakes
 * the agent.
 */

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { createAgent } = await import("#/modules/agents/service");
const { messages } = await import("#/modules/messaging/schema");
const { addChannelMembers, createChannel } = await import(
  "#/modules/messaging/service"
);
const { requestTakeover } = await import("#/modules/questions/service");
const { getQuestion } = await import("#/modules/questions/service");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { onCancelTakeover, onHandBack, pendingTakeoverOf } = await import(
  "./takeover-hook"
);

const OWNER_ID = "user_owner";
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

const fakeEnv = (DB: D1Database): Env =>
  ({
    AGENT_ROUTER: {
      get: () => ({ notifyMessage: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    CHANNEL_ROOM: {
      get: () => ({ broadcast: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    DB,
  }) as unknown as Env;

/** A workspace with a pending takeover from its agent, and the channel it was asked in. */
const seed = async () => {
  const DB = createTestD1();
  const env = fakeEnv(DB);
  const db = createDb(DB);
  const { workspace } = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: OWNER_ID,
      email: "owner@example.com",
      imageUrl: null,
      name: "Owner",
    },
  });
  const ref = { id: workspace.id, slug: workspace.slug };
  const { agent } = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Researcher",
    soul: "",
  });
  const channel = await createChannel(db, workspace.id, { name: "general" });
  await addChannelMembers(db, channel.id, [
    { memberId: agent.id, memberType: "agent" },
    { memberId: OWNER_ID, memberType: "user" },
  ]);
  const asked = await requestTakeover(db, env, ref, agent, {
    channelId: channel.id,
    reason: "Log in to the vendor portal",
  });
  if (!asked.ok) {
    throw new Error(`Could not ask: ${asked.reason}`);
  }
  return {
    agentId: agent.id,
    channelId: channel.id,
    env,
    questionId: asked.question.id,
    workspaceId: workspace.id,
  };
};

const answersIn = async (env: Env, channelId: string): Promise<string[]> => {
  const db = createDb(env.DB);
  const rows = await db
    .select({ body: messages.body })
    .from(messages)
    .where(eq(messages.channelId, channelId));
  return rows.map((row) => row.body).filter((body) => body.includes("Answer:"));
};

describe("hand back", () => {
  test("settles the takeover and posts the note once, as the reply that wakes the agent", async () => {
    const { agentId, channelId, env, questionId, workspaceId } = await seed();

    const outcome = await onHandBack({
      agentId,
      env,
      note: "Logged in, it is yours",
      userId: OWNER_ID,
      workspaceId,
    });

    expect(outcome.kind).toBe("settled");
    const question = await getQuestion(
      createDb(env.DB),
      workspaceId,
      questionId
    );
    expect(question?.status).toBe("handed_back");
    expect(question?.answer).toBe("Logged in, it is yours");
    expect(await answersIn(env, channelId)).toEqual([
      "@Researcher Answer: Logged in, it is yours",
    ]);
  });

  test("with no note, the reply says the desktop was handed back", async () => {
    const { agentId, channelId, env, workspaceId } = await seed();

    await onHandBack({
      agentId,
      env,
      note: "   ",
      userId: OWNER_ID,
      workspaceId,
    });

    expect(await answersIn(env, channelId)).toEqual([
      "@Researcher Answer: Handed back.",
    ]);
  });

  test("two hand-backs at once: one settles and posts, the other is already_handled", async () => {
    const { agentId, channelId, env, workspaceId } = await seed();
    const event = {
      agentId,
      env,
      note: null,
      userId: OWNER_ID,
      workspaceId,
    };

    const outcomes = await Promise.all([onHandBack(event), onHandBack(event)]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
      "already_handled",
      "settled",
    ]);
    expect(await answersIn(env, channelId)).toHaveLength(1);
  });

  test("a hand-back with nothing pending settles nothing and posts nothing", async () => {
    const { agentId, channelId, env, workspaceId } = await seed();
    await onHandBack({
      agentId,
      env,
      note: null,
      userId: OWNER_ID,
      workspaceId,
    });

    const outcome = await onHandBack({
      agentId,
      env,
      note: "again",
      userId: OWNER_ID,
      workspaceId,
    });

    expect(outcome.kind).toBe("none");
    expect(await answersIn(env, channelId)).toHaveLength(1);
  });
});

describe("cancel", () => {
  test("declining settles as cancelled and posts that the person declined", async () => {
    const { agentId, channelId, env, questionId, workspaceId } = await seed();

    const outcome = await onCancelTakeover({
      agentId,
      env,
      userId: OWNER_ID,
      workspaceId,
    });

    expect(outcome.kind).toBe("settled");
    const question = await getQuestion(
      createDb(env.DB),
      workspaceId,
      questionId
    );
    expect(question?.status).toBe("cancelled");
    expect(await answersIn(env, channelId)).toEqual([
      "@Researcher Answer: The person declined to take over.",
    ]);
  });

  test("a cancel after a hand-back is already_handled and posts nothing more", async () => {
    const { agentId, channelId, env, workspaceId } = await seed();
    await onHandBack({
      agentId,
      env,
      note: null,
      userId: OWNER_ID,
      workspaceId,
    });

    const outcome = await onCancelTakeover({
      agentId,
      env,
      userId: OWNER_ID,
      workspaceId,
    });

    expect(outcome.kind).toBe("none");
    expect(await answersIn(env, channelId)).toHaveLength(1);
  });
});

describe("pending takeover", () => {
  test("reports the waiting takeover, and nothing once it is settled", async () => {
    const { agentId, env, questionId, workspaceId } = await seed();

    expect(await pendingTakeoverOf(env, workspaceId, agentId)).toMatchObject({
      id: questionId,
      reason: "Log in to the vendor portal",
    });

    await onCancelTakeover({ agentId, env, userId: OWNER_ID, workspaceId });

    expect(await pendingTakeoverOf(env, workspaceId, agentId)).toBeNull();
  });
});
