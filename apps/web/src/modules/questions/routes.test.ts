import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import type { Db } from "#/db/client";

/**
 * The questions API as a member meets it: answering, losing the race to
 * somebody else, and being told who won without ever being told their Clerk id.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

let signedInAs: string | null = null;
mock.module("@clerk/hono", () => ({
  getAuth: () => (signedInAs ? { userId: signedInAs } : null),
}));

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const BOB_ID = "user_2bBobBBBBBBBBBBBBBBBBBBB";

const { createDb } = await import("#/db/client");
const { createAgent } = await import("#/modules/agents/service");
const { addChannelMember, createChannel, getThread } = await import(
  "#/modules/messaging/service"
);
const { addMember, createWorkspace } = await import(
  "#/modules/workspaces/service"
);
const { findClerkIdLeaksInBody } = await import(
  "#/modules/workspaces/clerk-id-leaks"
);
const { workspaceScopedRoutes } = await import("#/modules/workspaces/routes");
const { agentQuestionsRoutes, questionsRoutes } = await import("./routes");
const { ask, getQuestion } = await import("./service");

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

workspaceScopedRoutes.route("/questions", questionsRoutes);
workspaceScopedRoutes.route("/agents", agentQuestionsRoutes);

const app = new Hono<ApiEnv>();
app.route("/api/w/:workspaceSlug", workspaceScopedRoutes);

let db: Db;
let env: Env;
let agent: { id: string; name: string };
let channelId: string;
let bobMemberId: string;

const request = (
  path: string,
  init: { as?: string; body?: unknown; method?: string } = {}
) => {
  signedInAs = init.as ?? ADA_ID;
  return app.request(
    path,
    {
      ...(init.body === undefined
        ? {}
        : {
            body: JSON.stringify(init.body),
            headers: { "content-type": "application/json" },
          }),
      method: init.method ?? "GET",
    },
    env
  );
};

const fakeEnv = (d1: D1Database): Env =>
  ({
    AGENT_ROUTER: {
      get: () => ({ notifyMessage: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    CHANNEL_ROOM: {
      get: () => ({ broadcast: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    DB: d1,
  }) as unknown as Env;

let workspaceRef: { id: string; slug: string };

const askQuestion = async (options: string[] | null) => {
  const result = await ask(db, env, workspaceRef, agent, {
    channelId,
    options,
    prompt: "Ship it on Friday or Monday?",
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.question;
};

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1);
  env = fakeEnv(d1);

  const { workspace } = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: ADA_ID,
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada Lovelace",
    },
  });
  workspaceRef = { id: workspace.id, slug: workspace.slug };
  const bob = await addMember(db, workspace.id, {
    clerkUserId: BOB_ID,
    email: "bob@example.com",
    imageUrl: null,
    name: "Bob Barker",
    role: "member",
  });
  bobMemberId = bob.id;

  const created = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Researcher",
    soul: "",
  });
  agent = { id: created.agent.id, name: created.agent.name };
  const channel = await createChannel(db, workspace.id, { name: "ops" });
  channelId = channel.id;
  await addChannelMember(db, channel.id, {
    memberId: ADA_ID,
    memberType: "user",
  });
});

describe("GET /questions", () => {
  test("lists the workspace's questions, filtered by status", async () => {
    const question = await askQuestion(["Friday", "Monday"]);

    const response = await request("/api/w/alpha/questions?status=pending");
    const body = (await response.json()) as {
      questions: { id: string; options: string[]; status: string }[];
    };

    expect(response.status).toBe(200);
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0]).toMatchObject({
      id: question.id,
      options: ["Friday", "Monday"],
      status: "pending",
    });

    const answered = await request("/api/w/alpha/questions?status=answered");
    expect((await answered.json()) as unknown).toEqual({ questions: [] });

    const bad = await request("/api/w/alpha/questions?status=nonsense");
    expect(bad.status).toBe(400);
  });
});

describe("GET /agents/:id/questions", () => {
  test("answers for the agent, and 404s an id from nowhere", async () => {
    const question = await askQuestion(null);

    const mine = await request(`/api/w/alpha/agents/${agent.id}/questions`);
    const body = (await mine.json()) as { questions: { id: string }[] };
    expect(body.questions.map((row) => row.id)).toEqual([question.id]);

    const nobody = await request(
      "/api/w/alpha/agents/00000000-0000-4000-8000-000000000000/questions"
    );
    expect(nobody.status).toBe(404);
  });
});

describe("POST /questions/:id/answer", () => {
  test("answers, replies in the thread and hands back the answered card", async () => {
    const question = await askQuestion(["Friday", "Monday"]);

    const response = await request(
      `/api/w/alpha/questions/${question.id}/answer`,
      { body: { answer: "Monday" }, method: "POST" }
    );
    const raw = await response.text();
    const body = JSON.parse(raw) as {
      question: {
        answer: string;
        answeredBy: { name: string };
        status: string;
      };
    };

    expect(response.status).toBe(200);
    expect(body.question).toMatchObject({
      answer: "Monday",
      status: "answered",
    });
    expect(body.question.answeredBy.name).toBe("Ada Lovelace");
    // The answerer is a membership, never the Clerk id the message stores.
    expect(findClerkIdLeaksInBody(raw)).toEqual([]);

    const thread = await getThread(db, workspaceRef, question.messageId);
    expect(thread?.replies[0]?.body).toBe("@Researcher Answer: Monday");
  });

  test("a second answer gets 409 naming who answered first", async () => {
    const question = await askQuestion(["Friday", "Monday"]);
    await request(`/api/w/alpha/questions/${question.id}/answer`, {
      body: { answer: "Friday" },
      method: "POST",
    });

    const second = await request(
      `/api/w/alpha/questions/${question.id}/answer`,
      { as: BOB_ID, body: { answer: "Monday" }, method: "POST" }
    );
    const raw = await second.text();
    const body = JSON.parse(raw) as {
      error: string;
      question: { answer: string; answeredBy: { id: string; name: string } };
    };

    expect(second.status).toBe(409);
    expect(body.error).toBe("Already answered by Ada Lovelace.");
    expect(body.question.answer).toBe("Friday");
    expect(body.question.answeredBy.id).not.toBe(ADA_ID);
    expect(body.question.answeredBy.id).not.toBe(bobMemberId);
    expect(findClerkIdLeaksInBody(raw)).toEqual([]);
  });

  test("an answer outside the offered options is a 400, and changes nothing", async () => {
    const question = await askQuestion(["Friday", "Monday"]);
    const response = await request(
      `/api/w/alpha/questions/${question.id}/answer`,
      { body: { answer: "Whenever" }, method: "POST" }
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe('"answer" must be one of: Friday, Monday.');
    expect((await getQuestion(db, workspaceRef.id, question.id))?.status).toBe(
      "pending"
    );
  });

  test("any member of the workspace may answer, not only the channel's", async () => {
    const question = await askQuestion(["Friday", "Monday"]);
    const response = await request(
      `/api/w/alpha/questions/${question.id}/answer`,
      { as: BOB_ID, body: { answer: "Friday" }, method: "POST" }
    );
    expect(response.status).toBe(200);
    expect(
      (await getQuestion(db, workspaceRef.id, question.id))?.answeredBy
    ).toBe(bobMemberId);
  });
});
