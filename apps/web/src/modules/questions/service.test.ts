import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Db } from "#/db/client";

/**
 * Asking, answering and running out of time, against the shipped migrations
 * with the publish path exercised for real.
 *
 * Two things are being pinned down. First, that the messages a question
 * produces are ones the *router* knows how to act on: the answer and the expiry
 * notice both mention the agent, which is what wakes it. Second, that "first
 * answer wins" is the database's job - two answers land at once here, and
 * exactly one of them may post a reply.
 */

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { createDb } = await import("#/db/client");
const { createAgent } = await import("#/modules/agents/service");
const {
  addChannelMember,
  createChannel,
  getThread,
  isChannelMember,
  listChannelMessages,
} = await import("#/modules/messaging/service");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { findClerkIdLeaks } = await import(
  "#/modules/workspaces/clerk-id-leaks"
);
const {
  answerQuestion,
  ask,
  countPendingQuestionsByAgent,
  earliestQuestionExpiry,
  getQuestion,
  getQuestionForAgent,
  listQuestions,
  resolveIfExpired,
  sweepExpiredQuestions,
} = await import("./service");
const { toQuestionViews } = await import("./view");

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const BOB_ID = "user_2bBobBBBBBBBBBBBBBBBBBBB";

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

interface Broadcast {
  channelId: string;
  message?: { body: string; origin: string; question: unknown };
  question?: { status: string };
  type: string;
}

let db: Db;
let env: Env;
let broadcasts: Broadcast[];
let woken: { body: string; mentionedAgentIds: string[] }[];

const fakeEnv = (d1: D1Database): Env =>
  ({
    AGENT_ROUTER: {
      get: () => ({
        notifyMessage: (notification: {
          body: string;
          mentionedAgentIds: string[];
        }) => {
          woken.push(notification);
          return Promise.resolve();
        },
      }),
      idFromName: (name: string) => name,
    },
    CHANNEL_ROOM: {
      get: () => ({
        broadcast: (payload: string) => {
          broadcasts.push(JSON.parse(payload) as Broadcast);
          return Promise.resolve();
        },
      }),
      idFromName: (name: string) => name,
    },
    DB: d1,
  }) as unknown as Env;

interface Tenant {
  agent: { id: string; name: string };
  channelId: string;
  clerkUserId: string;
  memberId: string;
  slug: string;
  workspaceId: string;
}

const seed = async (name: string, clerkUserId: string): Promise<Tenant> => {
  const { member, workspace } = await createWorkspace(db, {
    name,
    owner: {
      clerkUserId,
      email: `${clerkUserId}@example.com`,
      imageUrl: null,
      name: name === "Alpha" ? "Ada Lovelace" : "Bob Barker",
    },
  });
  const { agent } = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Researcher",
    soul: "",
  });
  const channel = await createChannel(db, workspace.id, { name: "ops" });
  await addChannelMember(db, channel.id, {
    memberId: clerkUserId,
    memberType: "user",
  });

  return {
    agent: { id: agent.id, name: agent.name },
    channelId: channel.id,
    clerkUserId,
    memberId: member.id,
    slug: workspace.slug,
    workspaceId: workspace.id,
  };
};

const refOf = (tenant: Tenant) => ({
  id: tenant.workspaceId,
  slug: tenant.slug,
});

const answererOf = (tenant: Tenant) =>
  ({
    authorId: tenant.clerkUserId,
    authorType: "user",
    id: tenant.memberId,
    via: "web",
  }) as const;

const askIn = async (
  tenant: Tenant,
  input: {
    expiresIn?: number | null;
    kind?: "permission" | "question";
    options?: string[] | null;
    prompt?: string;
  } = {}
) => {
  const result = await ask(db, env, refOf(tenant), tenant.agent, {
    channelId: tenant.channelId,
    expiresIn: input.expiresIn ?? null,
    kind: input.kind,
    options: input.options ?? null,
    prompt: input.prompt ?? "Ship it on Friday or Monday?",
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result;
};

let alpha: Tenant;
let beta: Tenant;

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1);
  env = fakeEnv(d1);
  broadcasts = [];
  woken = [];
  alpha = await seed("Alpha", ADA_ID);
  beta = await seed("Beta", BOB_ID);
});

describe("ask", () => {
  test("posts a question card the agent authored, and a row pointing at it", async () => {
    const { message, question } = await askIn(alpha, {
      options: ["Friday", "Monday"],
    });

    expect(message.origin).toBe("question");
    expect(message.authorType).toBe("agent");
    expect(message.authorId).toBe(alpha.agent.id);
    expect(message.body).toBe("Ship it on Friday or Monday?");
    expect(question).toMatchObject({
      channelId: alpha.channelId,
      kind: "question",
      messageId: message.id,
      status: "pending",
      workspaceId: alpha.workspaceId,
    });
  });

  test("the message carries the question, from the first broadcast onwards", async () => {
    const { message } = await askIn(alpha, { options: ["Friday", "Monday"] });

    // What the open client is handed the moment the card appears - not on the
    // next reload.
    const created = broadcasts.find(
      (event) => event.type === "message.created"
    );
    expect(created?.message?.question).toMatchObject({
      options: ["Friday", "Monday"],
      status: "pending",
    });

    // And the same on a plain channel read.
    const page = await listChannelMessages(db, refOf(alpha), {
      channelId: alpha.channelId,
      limit: 10,
    });
    const card = page.messages.find((row) => row.id === message.id);
    expect(card?.question?.options).toEqual(["Friday", "Monday"]);
    expect(card?.question?.kind).toBe("question");
  });

  test("a permission request gets Approve/Deny without being asked", async () => {
    const { question } = await askIn(alpha, {
      kind: "permission",
      prompt: "May I delete the 14 stale rows?",
    });
    const [view] = await toQuestionViews(db, alpha.workspaceId, [question]);
    expect(view?.kind).toBe("permission");
    expect(view?.options).toEqual(["Approve", "Deny"]);
  });

  test("joins the agent to the channel, so the answer can wake it", async () => {
    const fresh = await createChannel(db, alpha.workspaceId, { name: "new" });
    await ask(db, env, refOf(alpha), alpha.agent, {
      channelId: fresh.id,
      prompt: "Anyone here?",
    });
    expect(
      await isChannelMember(db, fresh.id, {
        memberId: alpha.agent.id,
        memberType: "agent",
      })
    ).toBe(true);
  });

  test("refuses a channel from another workspace like one that does not exist", async () => {
    const result = await ask(db, env, refOf(alpha), alpha.agent, {
      channelId: beta.channelId,
      prompt: "trespassing",
    });
    const missing = await ask(db, env, refOf(alpha), alpha.agent, {
      channelId: "00000000-0000-4000-8000-000000000000",
      prompt: "trespassing",
    });
    expect(result).toEqual({
      ok: false,
      reason: "No such channel in this workspace.",
    });
    expect(missing).toEqual(result);
  });

  test("refuses an empty question and an oversized option list", async () => {
    const empty = await ask(db, env, refOf(alpha), alpha.agent, {
      channelId: alpha.channelId,
      prompt: "   ",
    });
    const tooMany = await ask(db, env, refOf(alpha), alpha.agent, {
      channelId: alpha.channelId,
      options: Array.from({ length: 11 }, (_, index) => `option ${index}`),
      prompt: "Pick one",
    });
    expect(empty.ok).toBe(false);
    expect(tooMany.ok).toBe(false);
  });
});

describe("answer", () => {
  test("records the answer and replies in the thread with a mention that wakes", async () => {
    const { question } = await askIn(alpha, { options: ["Friday", "Monday"] });
    woken = [];

    const result = await answerQuestion(db, env, refOf(alpha), question, {
      answer: "Monday",
      by: answererOf(alpha),
    });
    expect(result.ok).toBe(true);

    const stored = await getQuestion(db, alpha.workspaceId, question.id);
    expect(stored).toMatchObject({
      answer: "Monday",
      answeredBy: alpha.memberId,
      answeredVia: "web",
      status: "answered",
    });

    // The reply hangs under the card, and reads the way the routines firing
    // message does - a leading mention the router resolves.
    const thread = await getThread(db, refOf(alpha), question.messageId);
    const [reply] = thread?.replies ?? [];
    expect(reply?.body).toBe("@Researcher Answer: Monday");
    expect(reply?.origin).toBe("answer");
    expect(reply?.authorType).toBe("user");
    expect(reply?.mentions.map((mention) => mention.agentId)).toEqual([
      alpha.agent.id,
    ]);

    // And the router was told, with the agent among the mentions - the same
    // path a human's "@Researcher …" takes.
    const wake = woken.find((entry) => entry.body.startsWith("@Researcher"));
    expect(wake?.mentionedAgentIds).toEqual([alpha.agent.id]);

    // The card re-renders for everyone watching.
    const updated = broadcasts.filter(
      (event) => event.type === "question.updated"
    );
    expect(updated.at(-1)?.question?.status).toBe("answered");
  });

  test("first answer wins: the second is told who beat it, and posts nothing", async () => {
    const { question } = await askIn(alpha, { options: ["Friday", "Monday"] });

    const [first, second] = await Promise.all([
      answerQuestion(db, env, refOf(alpha), question, {
        answer: "Friday",
        by: answererOf(alpha),
      }),
      answerQuestion(db, env, refOf(alpha), question, {
        answer: "Monday",
        by: { ...answererOf(beta), authorType: "user" },
      }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);

    const loser = outcomes.find((outcome) => !outcome.ok);
    if (loser?.ok !== false || !("question" in loser)) {
      throw new Error("Expected one answer to lose the race.");
    }
    expect(loser.reason).toBe("already-resolved");
    expect(loser.question.status).toBe("answered");

    // The winner is named through the membership, never by a Clerk id.
    const [view] = await toQuestionViews(db, alpha.workspaceId, [
      loser.question,
    ]);
    expect(view?.answeredBy?.name).toBe("Ada Lovelace");
    expect(view?.answeredBy?.id).toBe(alpha.memberId);
    expect(findClerkIdLeaks(view)).toEqual([]);

    // Exactly one reply in the thread: the loser resolved nothing, so it said
    // nothing.
    const thread = await getThread(db, refOf(alpha), question.messageId);
    expect(thread?.replies).toHaveLength(1);
  });

  test("an answer that is not one of the options is refused", async () => {
    const { question } = await askIn(alpha, { options: ["Friday", "Monday"] });
    const result = await answerQuestion(db, env, refOf(alpha), question, {
      answer: "Whenever",
      by: answererOf(alpha),
    });
    expect(result).toEqual({ ok: false, reason: "invalid-option" });
    expect(
      (await getQuestion(db, alpha.workspaceId, question.id))?.status
    ).toBe("pending");
  });

  test("free text is allowed when the question offered no options", async () => {
    const { question } = await askIn(alpha, {
      prompt: "What should I call it?",
    });
    const result = await answerQuestion(db, env, refOf(alpha), question, {
      answer: "Call it Atlas",
      by: answererOf(alpha),
    });
    expect(result.ok).toBe(true);
    expect(
      (await getQuestion(db, alpha.workspaceId, question.id))?.answer
    ).toBe("Call it Atlas");
  });
});

describe("expiry", () => {
  const MINUTE = 60_000;

  test("an expired question resolves, posts the notice, and wakes the agent", async () => {
    const { question } = await askIn(alpha, {
      expiresIn: 60,
      options: ["Friday", "Monday"],
    });
    woken = [];

    const later = new Date(Date.now() + 2 * MINUTE);
    const resolved = await resolveIfExpired(
      db,
      env,
      refOf(alpha),
      question,
      later
    );
    expect(resolved.status).toBe("expired");

    const thread = await getThread(db, refOf(alpha), question.messageId);
    const [notice] = thread?.replies ?? [];
    expect(notice?.origin).toBe("answer");
    expect(notice?.authorType).toBe("external");
    expect(notice?.body).toStartWith("@Researcher Answer: (expired");
    expect(notice?.mentions.map((mention) => mention.agentId)).toEqual([
      alpha.agent.id,
    ]);
    expect(woken.at(-1)?.mentionedAgentIds).toEqual([alpha.agent.id]);
    expect(
      broadcasts.filter((event) => event.type === "question.updated").at(-1)
        ?.question?.status
    ).toBe("expired");
  });

  test("resolving twice posts one notice, and an answer afterwards is refused", async () => {
    const { question } = await askIn(alpha, { expiresIn: 60 });
    const later = new Date(Date.now() + 2 * MINUTE);

    await resolveIfExpired(db, env, refOf(alpha), question, later);
    await resolveIfExpired(db, env, refOf(alpha), question, later);
    const thread = await getThread(db, refOf(alpha), question.messageId);
    expect(thread?.replies).toHaveLength(1);

    const late = await answerQuestion(db, env, refOf(alpha), question, {
      answer: "Monday",
      by: answererOf(alpha),
    });
    if (late.ok !== false || !("question" in late)) {
      throw new Error("Expected the late answer to be refused.");
    }
    expect(late.question.status).toBe("expired");
  });

  test("the sweep takes the due ones and leaves the rest, per workspace", async () => {
    const due = await askIn(alpha, { expiresIn: 60 });
    const later = await askIn(alpha, { expiresIn: 3600 });
    const waiting = await askIn(alpha, {});
    const theirs = await askIn(beta, { expiresIn: 60 });

    const expired = await sweepExpiredQuestions(
      db,
      env,
      refOf(alpha),
      new Date(Date.now() + 2 * MINUTE)
    );
    expect(expired.map((row) => row.id)).toEqual([due.question.id]);

    const statuses = async (id: string) =>
      (
        await getQuestion(
          db,
          id === theirs.question.id ? beta.workspaceId : alpha.workspaceId,
          id
        )
      )?.status;
    expect(await statuses(later.question.id)).toBe("pending");
    expect(await statuses(waiting.question.id)).toBe("pending");
    // The other workspace's question is not this sweep's business.
    expect(await statuses(theirs.question.id)).toBe("pending");
  });

  test("the earliest expiry is what the workspace's alarm is armed for", async () => {
    expect(await earliestQuestionExpiry(db, alpha.workspaceId)).toBeNull();

    const soon = await askIn(alpha, { expiresIn: 60 });
    await askIn(alpha, { expiresIn: 3600 });
    await askIn(alpha, {});

    expect(
      (await earliestQuestionExpiry(db, alpha.workspaceId))?.getTime()
    ).toBe(soon.question.expiresAt?.getTime());

    // Answered questions leave the scan.
    await answerQuestion(db, env, refOf(alpha), soon.question, {
      answer: "done",
      by: answererOf(alpha),
    });
    const next = await earliestQuestionExpiry(db, alpha.workspaceId);
    expect(next?.getTime()).toBeGreaterThan(
      soon.question.expiresAt?.getTime() ?? 0
    );
  });
});

describe("scoping", () => {
  test("a question is reached through its own workspace, and its own agent", async () => {
    const { question } = await askIn(alpha, {});

    expect(
      await getQuestion(db, beta.workspaceId, question.id)
    ).toBeUndefined();
    expect(
      await getQuestionForAgent(
        db,
        alpha.workspaceId,
        beta.agent.id,
        question.id
      )
    ).toBeUndefined();
    expect(
      await getQuestionForAgent(
        db,
        alpha.workspaceId,
        alpha.agent.id,
        question.id
      )
    ).toBeDefined();

    // And the workspace list never sees the other's.
    const mine = await listQuestions(db, alpha.workspaceId);
    expect(mine.map((row) => row.id)).toEqual([question.id]);
  });

  test("pending counts are per agent, and drop expired and answered rows", async () => {
    const answered = await askIn(alpha, {});
    const due = await askIn(alpha, { expiresIn: 60 });
    await askIn(alpha, {});
    await askIn(beta, {});

    await answerQuestion(db, env, refOf(alpha), answered.question, {
      answer: "yes",
      by: answererOf(alpha),
    });

    const now = new Date(Date.now() + 2 * 60_000);
    const counts = await countPendingQuestionsByAgent(
      db,
      alpha.workspaceId,
      now
    );
    // Three asked, one answered, one past its expiry: one left.
    expect(counts.get(alpha.agent.id)).toBe(1);
    expect(counts.get(beta.agent.id)).toBeUndefined();
    expect(due.question.expiresAt).not.toBeNull();
  });
});
