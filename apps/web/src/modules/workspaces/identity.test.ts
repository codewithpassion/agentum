import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import { createDb, type Db } from "#/db/client";
import { findClerkIdLeaks, findClerkIdLeaksInBody } from "./clerk-id-leaks";

/**
 * The point of Phase 4: a human's Clerk id is stored, and never leaves.
 *
 * One workspace, three people and an agent, with messages, wiki revisions and
 * channel memberships written by all of them - then one of them is removed, so
 * the "Former member" path is exercised against real rows rather than a stub.
 * Every response body the resource routers produce is swept for a Clerk id.
 *
 * Same harness as `isolation.test.ts`: the shipped migrations in an in-memory
 * database, Clerk faked at the package boundary, `server.ts`'s mounts
 * replicated. `CHANNEL_ROOM` is stubbed with a recorder, which is how the
 * websocket payload gets asserted - it is the same view the HTTP response
 * carries, and this is what proves it.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

let signedInAs: string | null = null;
mock.module("@clerk/hono", () => ({
  getAuth: () => (signedInAs ? { userId: signedInAs } : null),
}));

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const GRACE_ID = "user_2bGraceBBBBBBBBBBBBBBBB";
const MALLORY_ID = "user_2cMalloryCCCCCCCCCCCCC";
const GHOST_ID = "user_2dGhostDDDDDDDDDDDDDDD";

interface FakeClerkUser {
  emailAddresses: { emailAddress: string }[];
  firstName: string | null;
  id: string;
  imageUrl: string;
  lastName: string | null;
  primaryEmailAddress: { emailAddress: string } | null;
}

const clerkUser = (id: string, email: string, name: string): FakeClerkUser => ({
  emailAddresses: [{ emailAddress: email }],
  firstName: name.split(" ")[0] ?? null,
  id,
  // Free of the Clerk id, so the sweep tests the views and not the fixture.
  imageUrl: `https://images.example.com/${email.split("@")[0]}.png`,
  lastName: name.split(" ")[1] ?? null,
  primaryEmailAddress: { emailAddress: email },
});

const directory = new Map<string, FakeClerkUser>([
  [ADA_ID, clerkUser(ADA_ID, "ada@example.com", "Ada Lovelace")],
  [GRACE_ID, clerkUser(GRACE_ID, "grace@example.com", "Grace Hopper")],
  [MALLORY_ID, clerkUser(MALLORY_ID, "mallory@example.com", "Mallory M")],
]);

mock.module("@clerk/backend", () => ({
  createClerkClient: () => ({
    users: {
      getUser: (id: string) => {
        const user = directory.get(id);
        return user
          ? Promise.resolve(user)
          : Promise.reject(new Error("Not Found"));
      },
      getUserList: ({ emailAddress }: { emailAddress: string[] }) => {
        const [wanted] = emailAddress;
        const data = [...directory.values()].filter(
          (user) => user.primaryEmailAddress?.emailAddress === wanted
        );
        return Promise.resolve({ data });
      },
    },
  }),
}));

const { agentActivityRoutes } = await import("#/modules/activity/routes");
const { agentsRoutes } = await import("#/modules/agents/routes");
const { attachmentsRoutes } = await import(
  "#/modules/messaging/routes/attachments"
);
const { channelsRoutes } = await import("#/modules/messaging/routes/channels");
const { messagesRoutes } = await import("#/modules/messaging/routes/messages");
const { wikiRoutes } = await import("#/modules/wiki/routes");
const { workspaceScopedRoutes } = await import("./routes");

const { createAgent } = await import("#/modules/agents/service");
const { storeAttachment } = await import(
  "#/modules/messaging/attachment-service"
);
const { addChannelMembers, createChannel, createMessage } = await import(
  "#/modules/messaging/service"
);
const { createPage, updatePage } = await import("#/modules/wiki/service");
const { addMember, createWorkspace, listMembers, removeMember } = await import(
  "./service"
);
const { resolveMemberAuthors } = await import("./authors");

const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

const createTestD1 = (): D1Database => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
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

const fakeBucket = (): R2Bucket => {
  const objects = new Map<string, string>();
  return {
    delete(key: string) {
      objects.delete(key);
      return Promise.resolve();
    },
    get(key: string) {
      const value = objects.get(key);
      return Promise.resolve(
        value === undefined
          ? null
          : {
              arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
              body: value,
              text: () => Promise.resolve(value),
            }
      );
    },
    put(key: string, value: string) {
      objects.set(key, String(value));
      return Promise.resolve({});
    },
  } as unknown as R2Bucket;
};

workspaceScopedRoutes.route("/agents", agentsRoutes);
workspaceScopedRoutes.route("/agents", agentActivityRoutes);
workspaceScopedRoutes.route("/channels", channelsRoutes);
workspaceScopedRoutes.route("/messages", messagesRoutes);
workspaceScopedRoutes.route("/attachments", attachmentsRoutes);
workspaceScopedRoutes.route("/wiki", wikiRoutes);

const app = new Hono<ApiEnv>();
app.route("/api/w/:workspaceSlug", workspaceScopedRoutes);

interface Seeded {
  adaMemberId: string;
  agentId: string;
  attachmentId: string;
  channelId: string;
  ghostMemberId: string;
  graceMemberId: string;
  malloryMessageId: string;
  workspaceId: string;
}

let d1: D1Database;
let db: Db;
let env: Env;
let bucket: R2Bucket;
let seeded: Seeded;
let broadcasts: string[];

const request = (
  path: string,
  init: { as?: string | null; body?: unknown; method?: string } = {}
) => {
  signedInAs = init.as === undefined ? ADA_ID : init.as;
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

const snapshotOf = (clerkUserId: string) => {
  const user = directory.get(clerkUserId);
  if (!user) {
    throw new Error(`No fake Clerk user ${clerkUserId}.`);
  }
  return {
    clerkUserId,
    email: user.primaryEmailAddress?.emailAddress ?? "",
    imageUrl: user.imageUrl,
    name: `${user.firstName} ${user.lastName}`,
  };
};

const memberIdOf = async (
  workspaceId: string,
  clerkUserId: string
): Promise<string> => {
  const members = await listMembers(db, workspaceId);
  const found = members.find((member) => member.clerkUserId === clerkUserId);
  if (!found) {
    throw new Error(`${clerkUserId} is not a member.`);
  }
  return found.id;
};

/**
 * Acme, with Ada (owner), Grace, a member whose Clerk snapshot never landed,
 * and Mallory - who writes, and is then removed, which is the only way to get
 * a message whose author has no membership left.
 */
const seed = async (): Promise<Seeded> => {
  const { workspace } = await createWorkspace(db, {
    name: "Acme Rockets",
    owner: snapshotOf(ADA_ID),
  });
  const workspaceId = workspace.id;
  const ref = { id: workspaceId, slug: workspace.slug };

  await addMember(db, workspaceId, { ...snapshotOf(GRACE_ID), role: "member" });
  await addMember(db, workspaceId, {
    ...snapshotOf(MALLORY_ID),
    role: "member",
  });
  // What migration 0012 leaves behind until the Clerk refresh runs.
  await addMember(db, workspaceId, {
    clerkUserId: GHOST_ID,
    email: "",
    imageUrl: null,
    name: null,
    role: "member",
  });

  const { agent } = await createAgent(db, workspaceId, {
    instructions: "",
    name: "Researcher",
    soul: "",
  });

  const channel = await createChannel(db, workspaceId, { name: "general" });
  await addChannelMembers(db, channel.id, [
    { memberId: ADA_ID, memberType: "user" },
    { memberId: MALLORY_ID, memberType: "user" },
    { memberId: GHOST_ID, memberType: "user" },
    { memberId: agent.id, memberType: "agent" },
  ]);

  const stored = await storeAttachment(
    db,
    bucket,
    new File(["hello"], "note.txt", { type: "text/plain" })
  );
  if (!stored.ok) {
    throw new Error("Could not seed the attachment.");
  }

  const posts = [
    { authorId: ADA_ID, authorType: "user" as const, body: "morning" },
    { authorId: GHOST_ID, authorType: "user" as const, body: "hello?" },
    { authorId: agent.id, authorType: "agent" as const, body: "on it" },
    { authorId: MALLORY_ID, authorType: "user" as const, body: "was here" },
  ];
  const written: string[] = [];
  for (const post of posts) {
    // biome-ignore lint/performance/noAwaitInLoops: the order of the messages is what the assertions read.
    const result = await createMessage(db, {
      ...post,
      ...(post.authorId === ADA_ID
        ? { attachmentIds: [stored.attachment.id] }
        : {}),
      channelId: channel.id,
      workspace: ref,
    });
    if (!result.ok) {
      throw new Error("Could not seed a message.");
    }
    written.push(result.message.id);
  }

  const page = await createPage(db, workspaceId, {
    author: { id: ADA_ID, type: "user" },
    body: "Notes.",
    title: "Runbook",
  });
  await updatePage(db, workspaceId, page.slug, {
    author: { id: MALLORY_ID, type: "user" },
    body: "Notes, edited.",
  });

  const malloryMemberId = await memberIdOf(workspaceId, MALLORY_ID);
  const result = {
    adaMemberId: await memberIdOf(workspaceId, ADA_ID),
    agentId: agent.id,
    attachmentId: stored.attachment.id,
    channelId: channel.id,
    ghostMemberId: await memberIdOf(workspaceId, GHOST_ID),
    graceMemberId: await memberIdOf(workspaceId, GRACE_ID),
    malloryMessageId: written.at(-1) ?? "",
    workspaceId,
  };
  // Mallory leaves; her messages, revisions and channel row stay behind.
  await removeMember(db, workspaceId, malloryMemberId);
  return result;
};

beforeEach(async () => {
  d1 = createTestD1();
  db = createDb(d1);
  bucket = fakeBucket();
  broadcasts = [];
  env = {
    ATTACHMENTS: bucket,
    CHANNEL_ROOM: {
      get: () => ({
        broadcast: (payload: string) => {
          broadcasts.push(payload);
          return Promise.resolve();
        },
      }),
      idFromName: (name: string) => name,
    },
    CLERK_SECRET_KEY: "sk_test_fake",
    DB: d1,
  } as unknown as Env;
  seeded = await seed();
});

interface AuthorShape {
  email: string | null;
  imageUrl: string | null;
  memberId: string | null;
  name: string;
}

interface MessageShape {
  author: AuthorShape | null;
  authorId: string;
  authorType: string;
  body: string;
  id: string;
}

const messagesOf = async (): Promise<MessageShape[]> => {
  const response = await request(
    `/api/w/acme-rockets/channels/${seeded.channelId}/messages`
  );
  const body = (await response.json()) as { messages: MessageShape[] };
  return body.messages;
};

const messageBy = (messages: MessageShape[], body: string): MessageShape => {
  const found = messages.find((message) => message.body === body);
  if (!found) {
    throw new Error(`No message "${body}".`);
  }
  return found;
};

describe("the leak assertion itself", () => {
  test("names the field that carries a Clerk id, and passes a clean body", () => {
    expect(
      findClerkIdLeaks({
        members: [{ email: "ada@example.com", id: "abc" }],
      })
    ).toEqual([]);
    expect(
      findClerkIdLeaks({ member: { clerkUserId: "user_2aAdaAAAAAAAAAA" } })
    ).toEqual([
      "$.member.clerkUserId (forbidden field)",
      '$.member.clerkUserId = "user_2aAdaAAAAAAAAAA"',
    ]);
    expect(findClerkIdLeaks({ authorId: "user_2aAdaAAAAAAAAAA" })).toEqual([
      '$.authorId = "user_2aAdaAAAAAAAAAA"',
    ]);
    // A Clerk-hosted avatar is the documented exception: the id inside it is
    // base64url-encoded, so it is not - and is not meant to be - detected.
    expect(
      findClerkIdLeaks({
        imageUrl:
          "https://img.clerk.com/eyJ0eXBlIjoiZGVmYXVsdCIsInJpZCI6InVzZXJfMmFBZGEifQ",
      })
    ).toEqual([]);
  });
});

describe("author resolution", () => {
  test("resolves a member, and a Clerk id with no membership left", async () => {
    const resolved = await resolveMemberAuthors(db, seeded.workspaceId, [
      ADA_ID,
      MALLORY_ID,
      GHOST_ID,
    ]);

    expect(resolved.get(ADA_ID)).toEqual({
      email: "ada@example.com",
      imageUrl: "https://images.example.com/ada.png",
      memberId: seeded.adaMemberId,
      name: "Ada Lovelace",
    });
    expect(resolved.get(MALLORY_ID)).toEqual({
      email: null,
      imageUrl: null,
      memberId: null,
      name: "Former member",
    });
    // A membership whose snapshot never landed still has to render as somebody.
    expect(resolved.get(GHOST_ID)).toEqual({
      email: null,
      imageUrl: null,
      memberId: seeded.ghostMemberId,
      name: "Member",
    });
  });

  test("asks the database once, however many ids repeat", async () => {
    const asked: string[] = [];
    const counted = createDb({
      ...(d1 as unknown as Record<string, unknown>),
      prepare: (query: string) => {
        asked.push(query);
        return (d1 as unknown as { prepare: (q: string) => unknown }).prepare(
          query
        );
      },
    } as unknown as D1Database);

    await resolveMemberAuthors(counted, seeded.workspaceId, [
      ADA_ID,
      ADA_ID,
      ADA_ID,
      MALLORY_ID,
    ]);
    expect(asked).toHaveLength(1);
  });
});

describe("message views", () => {
  test("carry the workspace member, never the Clerk id", async () => {
    const messages = await messagesOf();

    const mine = messageBy(messages, "morning");
    expect(mine.author).toEqual({
      email: "ada@example.com",
      imageUrl: "https://images.example.com/ada.png",
      memberId: seeded.adaMemberId,
      name: "Ada Lovelace",
    });
    // The id a client may address the author by is the member id.
    expect(mine.authorId).toBe(seeded.adaMemberId);

    const gone = messageBy(messages, "was here");
    expect(gone.author).toEqual({
      email: null,
      imageUrl: null,
      memberId: null,
      name: "Former member",
    });
    expect(gone.authorId).toBe("");

    const unfilled = messageBy(messages, "hello?");
    expect(unfilled.author?.name).toBe("Member");
    expect(unfilled.author?.email).toBeNull();
  });

  test("leave agent authors alone", async () => {
    const agentMessage = messageBy(await messagesOf(), "on it");
    expect(agentMessage.author).toBeNull();
    expect(agentMessage.authorId).toBe(seeded.agentId);
  });

  test("the POST response and the websocket broadcast carry the same author", async () => {
    const response = await request(
      `/api/w/acme-rockets/channels/${seeded.channelId}/messages`,
      { body: { body: "posted through the API" }, method: "POST" }
    );
    expect(response.status).toBe(201);
    const posted = (await response.json()) as { message: MessageShape };

    expect(posted.message.author?.memberId).toBe(seeded.adaMemberId);
    expect(posted.message.author?.name).toBe("Ada Lovelace");

    expect(broadcasts).toHaveLength(1);
    const event = JSON.parse(broadcasts[0] ?? "{}") as {
      message: MessageShape;
    };
    expect(event.message.author).toEqual(posted.message.author);
    expect(event.message.authorId).toBe(seeded.adaMemberId);
    expect(findClerkIdLeaksInBody(broadcasts[0] ?? "")).toEqual([]);
  });

  test("a thread's parent and replies resolve the same way", async () => {
    const parent = messageBy(await messagesOf(), "morning");
    const response = await request(
      `/api/w/acme-rockets/messages/${parent.id}/thread`
    );
    const body = (await response.json()) as { parent: MessageShape };
    expect(body.parent.author?.memberId).toBe(seeded.adaMemberId);
  });
});

describe("channel members", () => {
  test("a person is serialized by their membership, an agent by its row", async () => {
    const response = await request(
      `/api/w/acme-rockets/channels/${seeded.channelId}`
    );
    const body = (await response.json()) as {
      members: {
        email: string | null;
        memberId: string;
        memberType: string;
        name: string | null;
      }[];
    };

    const ada = body.members.find((member) => member.name === "Ada Lovelace");
    expect(ada).toEqual({
      avatar: null,
      email: "ada@example.com",
      imageUrl: "https://images.example.com/ada.png",
      memberId: seeded.adaMemberId,
      memberType: "user",
      name: "Ada Lovelace",
    } as unknown as typeof ada);

    // Mallory's channel row survives her membership; it is not shown, because
    // there is no member id left to address it by.
    expect(body.members.some((member) => member.name === "Mallory M")).toBe(
      false
    );
    expect(
      body.members.filter((member) => member.memberType === "user")
    ).toHaveLength(2);
    expect(
      body.members.some(
        (member) =>
          member.memberType === "agent" && member.name === "Researcher"
      )
    ).toBe(true);
  });

  test("adding and removing a person goes by member id, and answers with an email", async () => {
    const added = await request(
      `/api/w/acme-rockets/channels/${seeded.channelId}/members`,
      {
        body: { memberId: seeded.graceMemberId, memberType: "user" },
        method: "POST",
      }
    );
    expect(added.status).toBe(201);
    const body = (await added.json()) as {
      members: { email: string | null; memberId: string }[];
    };
    const grace = body.members.find(
      (member) => member.memberId === seeded.graceMemberId
    );
    expect(grace?.email).toBe("grace@example.com");

    // Stored by the Clerk id behind that membership, which is what survives a
    // member being removed from the workspace and added back.
    const stored = await d1
      .prepare(
        "SELECT member_id FROM channel_members WHERE channel_id = ? AND member_type = 'user'"
      )
      .bind(seeded.channelId)
      .all();
    expect(
      (stored.results as { member_id: string }[]).some(
        (row) => row.member_id === GRACE_ID
      )
    ).toBe(true);

    const removed = await request(
      `/api/w/acme-rockets/channels/${seeded.channelId}/members/user/${seeded.graceMemberId}`,
      { method: "DELETE" }
    );
    expect(removed.status).toBe(200);
    const after = (await removed.json()) as { members: { memberId: string }[] };
    expect(
      after.members.some((member) => member.memberId === seeded.graceMemberId)
    ).toBe(false);
  });

  test("a raw Clerk id is not a member id, and resolves to nothing", async () => {
    const response = await request(
      `/api/w/acme-rockets/channels/${seeded.channelId}/members`,
      { body: { memberId: GRACE_ID, memberType: "user" }, method: "POST" }
    );
    expect(response.status).toBe(404);
  });
});

describe("wiki authorship", () => {
  test("revisions name the member who wrote them", async () => {
    const response = await request(
      "/api/w/acme-rockets/wiki/runbook/revisions"
    );
    const body = (await response.json()) as {
      revisions: { author: AuthorShape | null; authorId: string }[];
    };

    const names = body.revisions.map((revision) => revision.author?.name);
    expect(names).toEqual(["Former member", "Ada Lovelace"]);
    expect(body.revisions.at(-1)?.authorId).toBe(seeded.adaMemberId);
    expect(body.revisions.at(0)?.authorId).toBe("");
  });
});

describe("the leak sweep", () => {
  test("no resource route serializes a Clerk user id", async () => {
    const posted = await request(
      `/api/w/acme-rockets/channels/${seeded.channelId}/messages`,
      { body: { body: "swept" }, method: "POST" }
    );
    const revisions = (await (
      await request("/api/w/acme-rockets/wiki/runbook/revisions")
    ).json()) as { revisions: { id: string }[] };
    const [newest] = revisions.revisions;
    if (!newest) {
      throw new Error("The seeded page has no revisions.");
    }

    const responses = await Promise.all([
      Promise.resolve(posted),
      request("/api/w/acme-rockets"),
      request("/api/w/acme-rockets/members"),
      request(`/api/w/acme-rockets/channels/${seeded.channelId}`),
      request(`/api/w/acme-rockets/channels/${seeded.channelId}/messages`),
      request(`/api/w/acme-rockets/attachments/${seeded.attachmentId}`),
      request(`/api/w/acme-rockets/agents/${seeded.agentId}/activity`),
      request("/api/w/acme-rockets/wiki"),
      request("/api/w/acme-rockets/wiki/runbook"),
      request("/api/w/acme-rockets/wiki/runbook/revisions"),
      request(`/api/w/acme-rockets/wiki/runbook/revisions/${newest.id}`),
      request(`/api/w/acme-rockets/channels/${seeded.channelId}/members`, {
        body: { memberId: seeded.graceMemberId, memberType: "user" },
        method: "POST",
      }),
    ]);

    const swept = await Promise.all(
      responses.map(async (response) => ({
        leaks: findClerkIdLeaksInBody(await response.text()),
        status: response.status,
      }))
    );

    // Every one answered, and none of them leaked - a 404 would sweep clean
    // for the wrong reason.
    expect(swept.every((entry) => entry.status < 400)).toBe(true);
    expect(swept.flatMap((entry) => entry.leaks)).toEqual([]);
    expect(broadcasts.flatMap(findClerkIdLeaksInBody)).toEqual([]);
  });
});
