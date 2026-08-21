import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import { createDb, type Db } from "#/db/client";

/**
 * The point of Phase 3: no id from another workspace resolves, through any
 * router, ever.
 *
 * Two workspaces are seeded with one member each and a full set of resources,
 * deliberately colliding where they can - the same agent name, the same wiki
 * and skill slug, the same connector URL - so a query that forgot its scope
 * would find the *wrong* row rather than none. Then user A asks for every one
 * of workspace B's ids through A's own path, and must get 404 every time.
 *
 * Same harness as `routes.test.ts`: the shipped migrations in an in-memory
 * database, Clerk faked at the package boundary, and the mounts `server.ts`
 * makes replicated here (importing `server.ts` would pull in the TanStack
 * server entry).
 */

// The messaging routes reach the router and channel Durable Objects through
// `publishMessage`; neither is exercised here, and the base class only has to
// exist for the modules to load.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

let signedInAs: string | null = null;
mock.module("@clerk/hono", () => ({
  getAuth: () => (signedInAs ? { userId: signedInAs } : null),
}));

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const BOB_ID = "user_2bBobBBBBBBBBBBBBBBBBBBB";

mock.module("@clerk/backend", () => ({
  createClerkClient: () => ({
    users: {
      getUser: (id: string) =>
        Promise.resolve({
          emailAddresses: [{ emailAddress: `${id}@example.com` }],
          firstName: "Test",
          id,
          imageUrl: "https://images.example.com/x.png",
          lastName: "User",
          primaryEmailAddress: { emailAddress: `${id}@example.com` },
        }),
      getUserList: () => Promise.resolve({ data: [] }),
    },
  }),
}));

const { agentActivityRoutes } = await import("#/modules/activity/routes");
const { agentsRoutes } = await import("#/modules/agents/routes");
const { agentSlackAppRoutes, bridgeRoutes, bridgesRoutes } = await import(
  "#/modules/bridges/routes"
);
const { browserRoutes } = await import("#/modules/browser/routes");
const { categoriesRoutes } = await import("#/modules/categories/routes");
const { computerRoutes } = await import("#/modules/computer/routes");
const { connectorsRoutes } = await import("#/modules/connectors/routes");
const { attachmentsRoutes } = await import(
  "#/modules/messaging/routes/attachments"
);
const { channelsRoutes } = await import("#/modules/messaging/routes/channels");
const { messagesRoutes } = await import("#/modules/messaging/routes/messages");
const { agentQuestionsRoutes, questionsRoutes } = await import(
  "#/modules/questions/routes"
);
const { routinesRoutes } = await import("#/modules/routines/routes");
const { skillsRoutes } = await import("#/modules/skills/routes");
const { wikiRoutes } = await import("#/modules/wiki/routes");
const { workspaceScopedRoutes } = await import("./routes");

const { createAgent, findAgentByMcpToken } = await import(
  "#/modules/agents/service"
);
const { upsertBridge } = await import("#/modules/bridges/bridges");
const { findInternalId, recordExternalRef } = await import(
  "#/modules/bridges/refs"
);
const { claimSlackKey } = await import("#/modules/bridges/events-seen");
const { storeScreenshot } = await import("#/modules/browser/service");
const { createDraftSlackApp } = await import("#/modules/bridges/slack/apps");
const { createCategory } = await import("#/modules/categories/service");
const { addConnector } = await import("#/modules/connectors/service");
const { storeAttachment } = await import(
  "#/modules/messaging/attachment-service"
);
const { createChannel, createMessage } = await import(
  "#/modules/messaging/service"
);
const { ask } = await import("#/modules/questions/service");
const { createRoutine } = await import("#/modules/routines/service");
const { createSkill } = await import("#/modules/skills/service");
const { validateSkill } = await import("#/modules/skills/validate");
const { createPage, storeAsset } = await import("#/modules/wiki/service");
const { createWorkspace, deleteWorkspace } = await import("./service");

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
    // Drizzle's D1 driver runs a batch as `prepare().bind()` statements handed
    // back to `batch`; `createMessage` is the one write here that uses it.
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

/** Writes into the caller's map, so a test can see what is still stored. */
const fakeBucket = (objects: Map<string, string>): R2Bucket =>
  ({
    // R2 takes one key or a batch, and the cleanups send batches.
    delete(key: string | string[]) {
      for (const one of typeof key === "string" ? [key] : key) {
        objects.delete(one);
      }
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
  }) as unknown as R2Bucket;

/**
 * The mounts `server.ts` makes, in the order it makes them: onto
 * `workspaceScopedRoutes` first, then that onto the app. `routes.test.ts`
 * mounts a `/probe` router onto the same singleton; the two never collide.
 */
workspaceScopedRoutes.route("/agents", agentsRoutes);
workspaceScopedRoutes.route("/agents", computerRoutes);
workspaceScopedRoutes.route("/agents", browserRoutes);
workspaceScopedRoutes.route("/agents", agentActivityRoutes);
workspaceScopedRoutes.route("/agents", agentSlackAppRoutes);
workspaceScopedRoutes.route("/agents", agentQuestionsRoutes);
workspaceScopedRoutes.route("/channels", channelsRoutes);
workspaceScopedRoutes.route("/categories", categoriesRoutes);
workspaceScopedRoutes.route("/messages", messagesRoutes);
workspaceScopedRoutes.route("/attachments", attachmentsRoutes);
workspaceScopedRoutes.route("/wiki", wikiRoutes);
workspaceScopedRoutes.route("/connectors", connectorsRoutes);
workspaceScopedRoutes.route("/skills", skillsRoutes);
workspaceScopedRoutes.route("/routines", routinesRoutes);
workspaceScopedRoutes.route("/questions", questionsRoutes);
workspaceScopedRoutes.route("/channels", bridgeRoutes);
workspaceScopedRoutes.route("/bridges", bridgesRoutes);

const app = new Hono<ApiEnv>();
app.route("/api/w/:workspaceSlug", workspaceScopedRoutes);

interface Seeded {
  agentId: string;
  attachmentId: string;
  bridgeChannelId: string;
  categoryId: string;
  channelId: string;
  connectorId: string;
  /** The Slack message id its bridge recorded a ref for. */
  externalMessageId: string;
  mcpToken: string;
  messageId: string;
  questionId: string;
  /** Every object this workspace's seed put in R2. */
  r2Keys: string[];
  routineId: string;
  skillSlug: string;
  slackAppId: string;
  wikiAssetId: string;
  wikiSlug: string;
  workspaceId: string;
}

let d1: D1Database;
let db: Db;
let env: Env;
let bucket: R2Bucket;
let r2Objects: Map<string, string>;
let alpha: Seeded;
let beta: Seeded;

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

const SKILL_MD = `---
name: shared-slug
description: A skill both workspaces happen to have.
---

Body.
`;

/**
 * One workspace with one of everything. The names, slugs and URLs are the same
 * in both workspaces on purpose: that is what turns a missing scope from "no
 * row" into "somebody else's row".
 */
const seedWorkspace = async (
  name: string,
  slug: string,
  clerkUserId: string
): Promise<Seeded> => {
  const { workspace } = await createWorkspace(db, {
    name,
    owner: {
      clerkUserId,
      email: `${clerkUserId}@example.com`,
      imageUrl: null,
      name: "Test User",
    },
  });
  const workspaceId = workspace.id;
  const ref = { id: workspaceId, slug: workspace.slug };
  const bucketBefore = new Set(r2Objects.keys());

  const { agent, mcpToken } = await createAgent(db, workspaceId, {
    instructions: "",
    name: "Ada",
    soul: "",
  });

  const channel = await createChannel(db, workspaceId, { name: "general" });
  const bridged = await createChannel(db, workspaceId, { name: "bridged" });
  const slackApp = await createDraftSlackApp(db, workspaceId, agent.id);
  await upsertBridge(db, workspaceId, {
    agentId: agent.id,
    channelId: bridged.id,
    connector: "slack",
    externalChannelId: `C${slug.toUpperCase()}0000`,
    slackAppId: slackApp.id,
  });

  const stored = await storeAttachment(
    db,
    bucket,
    new File(["hello"], "note.txt", { type: "text/plain" })
  );
  if (!stored.ok) {
    throw new Error("Could not seed the attachment.");
  }

  const posted = await createMessage(db, {
    attachmentIds: [stored.attachment.id],
    authorId: clerkUserId,
    authorType: "user",
    body: "hello",
    channelId: channel.id,
    workspace: ref,
  });
  if (!posted.ok) {
    throw new Error("Could not seed the message.");
  }

  const category = await createCategory(db, workspaceId, { name: "Product" });

  const validated = validateSkill({
    files: [{ content: SKILL_MD, path: "SKILL.md" }],
    slug: "shared-slug",
  });
  if (!validated.ok) {
    throw new Error(validated.reason);
  }
  await createSkill(db, bucket, workspaceId, {
    changelog: "Created.",
    createdBy: "user",
    skill: validated.skill,
    slug: "shared-slug",
  });

  const routine = await createRoutine(db, workspaceId, {
    agentId: agent.id,
    channelId: channel.id,
    instructions: "summarize yesterday's activity",
    name: "Morning summary",
    nextRunAt: new Date(Date.now() + 3_600_000),
    schedule: { time: "09:00", type: "daily" },
    timezone: "UTC",
  });

  const asked = await ask(db, env, ref, agent, {
    channelId: channel.id,
    options: ["Approve", "Deny"],
    prompt: "May I delete the 14 stale rows?",
  });
  if (!asked.ok) {
    throw new Error("Could not seed the question.");
  }

  const page = await createPage(db, workspaceId, {
    author: { id: clerkUserId, type: "user" },
    body: "Notes.",
    title: "Runbook",
  });
  // Attached to the page: an unattached asset has no parent to scope through,
  // which is a deliberate exception (see `getAssetInWorkspace`).
  const asset = await storeAsset(
    db,
    workspaceId,
    bucket,
    new File(["png"], "diagram.png", { type: "image/png" }),
    page.id
  );
  if (!asset.ok) {
    throw new Error("Could not seed the wiki asset.");
  }

  await storeScreenshot(db, bucket, {
    agentId: agent.id,
    bytes: new Uint8Array([1, 2, 3]),
    pageUrl: "https://example.com",
    title: "Example",
    workspaceSlug: workspace.slug,
  });

  // What the bridge writes down for a message it mirrored: the row carries no
  // workspace, only the message it points at.
  const externalMessageId = `${slug}-1700000000.000100`;
  await recordExternalRef(db, "slack", {
    externalId: externalMessageId,
    internalId: posted.message.id,
    internalType: "message",
  });

  // No network: the probe fails, the row lands `unconfigured`, which is all
  // this test needs from it.
  const { connector } = await addConnector(
    {
      db,
      fetchImpl: (() =>
        Promise.reject(new Error("offline"))) as unknown as typeof fetch,
      key: null,
      redirectUri: "https://app.example.com/cb",
      vaults: null,
    },
    workspaceId,
    { url: "https://mcp.example.com/sse" }
  );

  return {
    agentId: agent.id,
    attachmentId: stored.attachment.id,
    bridgeChannelId: bridged.id,
    categoryId: category.id,
    channelId: channel.id,
    connectorId: connector.id,
    externalMessageId,
    mcpToken,
    messageId: posted.message.id,
    questionId: asked.question.id,
    r2Keys: [...r2Objects.keys()].filter((key) => !bucketBefore.has(key)),
    routineId: routine.id,
    skillSlug: "shared-slug",
    slackAppId: slackApp.id,
    wikiAssetId: asset.asset.id,
    wikiSlug: "runbook",
    workspaceId,
  };
};

beforeEach(async () => {
  d1 = createTestD1();
  db = createDb(d1);
  r2Objects = new Map();
  bucket = fakeBucket(r2Objects);
  env = {
    // Asking a question publishes a message, which fans out to the channel
    // room and the router; both are stubbed so the seed takes the real path.
    AGENT_ROUTER: {
      get: () => ({ notifyMessage: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    ATTACHMENTS: bucket,
    CHANNEL_ROOM: {
      get: () => ({ broadcast: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    CLERK_SECRET_KEY: "sk_test_fake",
    DB: d1,
  } as unknown as Env;
  alpha = await seedWorkspace("Alpha", "alpha", ADA_ID);
  beta = await seedWorkspace("Beta", "beta", BOB_ID);
});

describe("requireWorkspace, from the outside", () => {
  test("a member of one workspace cannot reach the other's path at all", async () => {
    const paths = [
      "/api/w/beta",
      "/api/w/beta/agents",
      "/api/w/beta/channels",
      "/api/w/beta/categories",
      "/api/w/beta/wiki",
      "/api/w/beta/skills",
      "/api/w/beta/connectors",
    ];
    const statuses = await Promise.all(
      paths.map(async (path) => (await request(path)).status)
    );
    expect(statuses).toEqual(paths.map(() => 404));
  });
});

describe("list endpoints return only their own workspace's rows", () => {
  test("agents, channels, categories, wiki, skills and connectors", async () => {
    const agents = (await (await request("/api/w/alpha/agents")).json()) as {
      agents: { id: string }[];
    };
    expect(agents.agents.map((row) => row.id)).toEqual([alpha.agentId]);

    const channels = (await (
      await request("/api/w/alpha/channels")
    ).json()) as {
      channels: { id: string }[];
    };
    expect(channels.channels.map((row) => row.id).sort()).toEqual(
      [alpha.channelId, alpha.bridgeChannelId].sort()
    );

    const categories = (await (
      await request("/api/w/alpha/categories")
    ).json()) as { categories: { id: string }[] };
    expect(categories.categories.map((row) => row.id)).toEqual([
      alpha.categoryId,
    ]);

    const pages = (await (await request("/api/w/alpha/wiki")).json()) as {
      pages: { id: string }[];
    };
    expect(pages.pages).toHaveLength(1);

    const skills = (await (await request("/api/w/alpha/skills")).json()) as {
      skills: { id: string }[];
    };
    expect(skills.skills).toHaveLength(1);

    const connectors = (await (
      await request("/api/w/alpha/connectors")
    ).json()) as { connectors: { id: string }[] };
    expect(connectors.connectors.map((row) => row.id)).toEqual([
      alpha.connectorId,
    ]);

    const routines = (await (
      await request("/api/w/alpha/routines")
    ).json()) as {
      routines: { id: string }[];
    };
    expect(routines.routines.map((row) => row.id)).toEqual([alpha.routineId]);
  });

  test("a shared slug resolves to the caller's own row, never the other's", async () => {
    const page = (await (
      await request(`/api/w/alpha/wiki/${alpha.wikiSlug}`)
    ).json()) as { page: { id: string } };
    const skill = (await (
      await request(`/api/w/alpha/skills/${alpha.skillSlug}`)
    ).json()) as { skill: { id: string } };

    const betaPage = (await (
      await request(`/api/w/beta/wiki/${beta.wikiSlug}`, { as: BOB_ID })
    ).json()) as { page: { id: string } };
    const betaSkill = (await (
      await request(`/api/w/beta/skills/${beta.skillSlug}`, { as: BOB_ID })
    ).json()) as { skill: { id: string } };

    expect(page.page.id).not.toBe(betaPage.page.id);
    expect(skill.skill.id).not.toBe(betaSkill.skill.id);
  });
});

/**
 * The IDOR sweep: workspace B's ids, addressed through workspace A's own path
 * by a member of A. Every one has to be a 404 - or a 400 where the id never
 * even reaches a query, which is the same refusal.
 */
describe("workspace B's ids through workspace A's path", () => {
  interface Attempt {
    body?: unknown;
    method?: string;
    path: string;
  }

  /**
   * Every attempt, run and reported as `{ path, status }` so a failure names
   * the route that leaked rather than just "expected 404".
   */
  const sweep = async (attempts: readonly Attempt[]) =>
    await Promise.all(
      attempts.map(async ({ path, ...init }) => ({
        path,
        status: (await request(path, init)).status,
      }))
    );

  const allRefused = (attempts: readonly Attempt[]) =>
    attempts.map(({ path }) => ({ path, status: 404 }));

  test("agents: get, patch, delete, status", async () => {
    const attempts = [
      { path: `/api/w/alpha/agents/${beta.agentId}` },
      {
        body: { name: "Stolen" },
        method: "PATCH",
        path: `/api/w/alpha/agents/${beta.agentId}`,
      },
      { method: "DELETE", path: `/api/w/alpha/agents/${beta.agentId}` },
      { path: `/api/w/alpha/agents/${beta.agentId}/status` },
    ];
    expect(await sweep(attempts)).toEqual(allRefused(attempts));
  });

  test("an agent's subroutes: activity, computer, browser", async () => {
    const attempts = [
      { path: `/api/w/alpha/agents/${beta.agentId}/activity` },
      { path: `/api/w/alpha/agents/${beta.agentId}/computer/ls` },
      { path: `/api/w/alpha/agents/${beta.agentId}/computer/file?path=/x.txt` },
      { path: `/api/w/alpha/agents/${beta.agentId}/browser/screenshots` },
      { path: `/api/w/alpha/agents/${beta.agentId}/browser/status` },
    ];
    expect(await sweep(attempts)).toEqual(allRefused(attempts));
  });

  test("channels: get, delete, members, messages, socket", async () => {
    const attempts = [
      { path: `/api/w/alpha/channels/${beta.channelId}` },
      { method: "DELETE", path: `/api/w/alpha/channels/${beta.channelId}` },
      { path: `/api/w/alpha/channels/${beta.channelId}/messages` },
      {
        body: { body: "trespassing" },
        method: "POST",
        path: `/api/w/alpha/channels/${beta.channelId}/messages`,
      },
      {
        body: { memberId: ADA_ID, memberType: "user" },
        method: "POST",
        path: `/api/w/alpha/channels/${beta.channelId}/members`,
      },
      {
        method: "DELETE",
        path: `/api/w/alpha/channels/${beta.channelId}/members/user/${BOB_ID}`,
      },
      { path: `/api/w/alpha/channels/${beta.channelId}/ws` },
    ];
    expect(await sweep(attempts)).toEqual(allRefused(attempts));
  });

  test("channel creation cannot name another workspace's agent", async () => {
    const attempts = [
      {
        body: { agentId: beta.agentId, kind: "dm" },
        method: "POST",
        path: "/api/w/alpha/channels",
      },
      {
        body: { agentIds: [beta.agentId], name: "trespassing" },
        method: "POST",
        path: "/api/w/alpha/channels",
      },
    ];
    expect(await sweep(attempts)).toEqual(allRefused(attempts));
  });

  test("messages: a thread reached through its channel's workspace", async () => {
    const theirs = await request(
      `/api/w/alpha/messages/${beta.messageId}/thread`
    );
    // And the caller's own message still resolves, so the 404 is scope, not a
    // broken route.
    const mine = await request(
      `/api/w/alpha/messages/${alpha.messageId}/thread`
    );
    expect([theirs.status, mine.status]).toEqual([404, 200]);
  });

  test("attachments: scoped through message and channel", async () => {
    const theirs = await request(
      `/api/w/alpha/attachments/${beta.attachmentId}`
    );
    const mine = await request(
      `/api/w/alpha/attachments/${alpha.attachmentId}`
    );
    expect([theirs.status, mine.status]).toEqual([404, 200]);
  });

  test("categories: patch, delete, item assignment", async () => {
    const attempts = [
      {
        body: { name: "Stolen" },
        method: "PATCH",
        path: `/api/w/alpha/categories/${beta.categoryId}`,
      },
      { method: "DELETE", path: `/api/w/alpha/categories/${beta.categoryId}` },
      {
        body: { itemId: alpha.channelId, itemType: "channel" },
        method: "PUT",
        path: `/api/w/alpha/categories/${beta.categoryId}/items`,
      },
      {
        method: "DELETE",
        path: `/api/w/alpha/categories/${beta.categoryId}/items/channel/${beta.channelId}`,
      },
      // Nor may one of A's own categories be pointed at one of B's channels.
      {
        body: { itemId: beta.channelId, itemType: "channel" },
        method: "PUT",
        path: `/api/w/alpha/categories/${alpha.categoryId}/items`,
      },
    ];
    expect(await sweep(attempts)).toEqual(allRefused(attempts));
  });

  test("wiki: page, revisions, assets", async () => {
    // The shared slug resolves to A's own page (asserted above); a slug only B
    // has must not resolve at all, through any verb.
    const attempts = [
      { path: "/api/w/alpha/wiki/nothing-here" },
      {
        body: { body: "x" },
        method: "PATCH",
        path: "/api/w/alpha/wiki/nothing-here",
      },
      { method: "DELETE", path: "/api/w/alpha/wiki/nothing-here" },
      { path: "/api/w/alpha/wiki/nothing-here/revisions" },
      { path: `/api/w/alpha/wiki/assets/${beta.wikiAssetId}` },
    ];
    expect(await sweep(attempts)).toEqual(allRefused(attempts));
  });

  test("skills: read, publish a version, retry, delete, assignment", async () => {
    const attempts = [
      { path: "/api/w/alpha/skills/not-mine" },
      {
        body: {
          changelog: "x",
          files: [{ content: SKILL_MD, path: "SKILL.md" }],
        },
        method: "POST",
        path: "/api/w/alpha/skills/not-mine/versions",
      },
      { method: "POST", path: "/api/w/alpha/skills/not-mine/retry-sync" },
      { method: "DELETE", path: "/api/w/alpha/skills/not-mine" },
      { path: "/api/w/alpha/skills/not-mine/agents" },
      // A's own skill may not be assigned to B's agent.
      {
        body: { agentId: beta.agentId },
        method: "POST",
        path: `/api/w/alpha/skills/${alpha.skillSlug}/agents`,
      },
      { path: `/api/w/alpha/skills?agentId=${beta.agentId}` },
    ];
    expect(await sweep(attempts)).toEqual(allRefused(attempts));
  });

  test("connectors: get, patch, delete, test, assignment", async () => {
    const attempts = [
      { path: `/api/w/alpha/connectors/${beta.connectorId}` },
      {
        body: { name: "Stolen" },
        method: "PATCH",
        path: `/api/w/alpha/connectors/${beta.connectorId}`,
      },
      { method: "DELETE", path: `/api/w/alpha/connectors/${beta.connectorId}` },
      {
        method: "POST",
        path: `/api/w/alpha/connectors/${beta.connectorId}/test`,
      },
      { path: `/api/w/alpha/connectors/${beta.connectorId}/agents` },
      {
        body: { agentId: beta.agentId },
        method: "POST",
        path: `/api/w/alpha/connectors/${alpha.connectorId}/agents`,
      },
      { path: `/api/w/alpha/connectors?agentId=${beta.agentId}` },
    ];
    expect(await sweep(attempts)).toEqual(allRefused(attempts));
  });

  test("routines: read, patch, delete, run history and running one", async () => {
    const attempts = [
      { path: `/api/w/alpha/routines/${beta.routineId}` },
      {
        body: { name: "Stolen" },
        method: "PATCH",
        path: `/api/w/alpha/routines/${beta.routineId}`,
      },
      { method: "DELETE", path: `/api/w/alpha/routines/${beta.routineId}` },
      { path: `/api/w/alpha/routines/${beta.routineId}/runs` },
      { method: "POST", path: `/api/w/alpha/routines/${beta.routineId}/run` },
      // Nor may one be created against another workspace's agent or channel.
      {
        body: {
          agentId: beta.agentId,
          channelId: alpha.channelId,
          instructions: "trespassing",
          name: "Stolen",
          schedule: { time: "09:00", type: "daily" },
          timezone: "UTC",
        },
        method: "POST",
        path: "/api/w/alpha/routines",
      },
      {
        body: {
          agentId: alpha.agentId,
          channelId: beta.channelId,
          instructions: "trespassing",
          name: "Stolen",
          schedule: { time: "09:00", type: "daily" },
          timezone: "UTC",
        },
        method: "POST",
        path: "/api/w/alpha/routines",
      },
      // And an existing routine may not be repointed at either.
      {
        body: { agentId: beta.agentId },
        method: "PATCH",
        path: `/api/w/alpha/routines/${alpha.routineId}`,
      },
      {
        body: { channelId: beta.channelId },
        method: "PATCH",
        path: `/api/w/alpha/routines/${alpha.routineId}`,
      },
    ];
    expect(await sweep(attempts)).toEqual(allRefused(attempts));

    // Beta's routine is still there, and still enabled: none of the above
    // reached it.
    const own = (await (
      await request(`/api/w/beta/routines/${beta.routineId}`, { as: BOB_ID })
    ).json()) as { routine: { enabled: boolean; id: string } };
    expect(own.routine).toMatchObject({ enabled: true, id: beta.routineId });
  });

  test("questions: another workspace's question cannot be read or answered", async () => {
    const attempts = [
      {
        body: { answer: "Approve" },
        method: "POST",
        path: `/api/w/alpha/questions/${beta.questionId}/answer`,
      },
      { path: `/api/w/alpha/agents/${beta.agentId}/questions` },
    ];
    expect(await sweep(attempts)).toEqual(allRefused(attempts));

    // Beta's question is untouched: still pending, still unanswered.
    const own = (await (
      await request("/api/w/beta/questions?status=pending", { as: BOB_ID })
    ).json()) as { questions: { id: string; status: string }[] };
    expect(own.questions).toEqual([
      expect.objectContaining({ id: beta.questionId, status: "pending" }),
    ]);

    // And Alpha's own list never shows it.
    const mine = (await (await request("/api/w/alpha/questions")).json()) as {
      questions: { id: string }[];
    };
    expect(mine.questions.map((row) => row.id)).toEqual([alpha.questionId]);
  });

  test("bridges: read, create, delete, and the agent's surfaces", async () => {
    const attempts = [
      { path: `/api/w/alpha/channels/${beta.bridgeChannelId}/bridge` },
      {
        body: { externalChannelId: "C0123ABCDEF" },
        method: "POST",
        path: `/api/w/alpha/channels/${beta.bridgeChannelId}/bridge`,
      },
      {
        method: "DELETE",
        path: `/api/w/alpha/channels/${beta.bridgeChannelId}/bridge`,
      },
      { path: `/api/w/alpha/bridges/bridges?agentId=${beta.agentId}` },
    ];
    expect(await sweep(attempts)).toEqual(allRefused(attempts));
  });

  test("slack apps: create, read, tokens, disconnect", async () => {
    const attempts = [
      {
        method: "POST",
        path: `/api/w/alpha/agents/${beta.agentId}/slack-app`,
      },
      { path: `/api/w/alpha/agents/${beta.agentId}/slack-app` },
      {
        body: { botToken: "xoxb-stolen", signingSecret: "s" },
        method: "PUT",
        path: `/api/w/alpha/agents/${beta.agentId}/slack-app/tokens`,
      },
      {
        method: "DELETE",
        path: `/api/w/alpha/agents/${beta.agentId}/slack-app`,
      },
      // And the app's own id, offered as the app to bridge a channel through.
      {
        body: {
          externalChannelId: "C0123ABCDEF",
          slackAppId: beta.slackAppId,
        },
        method: "POST",
        path: `/api/w/alpha/channels/${alpha.bridgeChannelId}/bridge`,
      },
    ];
    expect(await sweep(attempts)).toEqual(allRefused(attempts));

    // Beta's app is still there: none of the above deleted it.
    const own = (await (
      await request(`/api/w/beta/agents/${beta.agentId}/slack-app`, {
        as: BOB_ID,
      })
    ).json()) as { slackApp: { id: string } | null };
    expect(own.slackApp?.id).toBe(beta.slackAppId);
  });
});

describe("deleting a workspace", () => {
  test("takes its agents' MCP surface with it", async () => {
    // The token lookup is global by design - a credential is resolved before
    // any workspace is known - so an orphaned agent row would stay reachable.
    expect(await findAgentByMcpToken(db, beta.mcpToken)).toBeDefined();

    await deleteWorkspace(db, bucket, beta.workspaceId);

    expect(await findAgentByMcpToken(db, beta.mcpToken)).toBeUndefined();
    // And the other workspace is untouched.
    expect(await findAgentByMcpToken(db, alpha.mcpToken)).toBeDefined();
  });

  test("leaves no root rows behind, and none of the other workspace's", async () => {
    // A run for each workspace's routine: `routine_runs` carries no workspace
    // of its own, so it is only reachable - and only deletable - through the
    // routine above it.
    await Promise.all(
      [alpha, beta].map((seeded) =>
        d1
          .prepare(
            "INSERT INTO routine_runs (id, routine_id, scheduled_for, fired_at, status) VALUES (?, ?, ?, ?, 'posted')"
          )
          .bind(`run-${seeded.routineId}`, seeded.routineId, 1, 1)
          .run()
      )
    );

    await deleteWorkspace(db, bucket, beta.workspaceId);

    const counts = async (table: string, workspaceId: string) => {
      const rows = await d1
        .prepare(`SELECT id FROM ${table} WHERE workspace_id = ?`)
        .bind(workspaceId)
        .all();
      return { rows: rows.results.length, table };
    };

    const tables = [
      "agents",
      "channels",
      "categories",
      "connectors",
      "skills",
      "wiki_pages",
      "channel_bridges",
      "slack_apps",
      "routines",
      "agent_questions",
    ];
    const gone = await Promise.all(
      tables.map((table) => counts(table, beta.workspaceId))
    );
    const kept = await Promise.all(
      tables.map((table) => counts(table, alpha.workspaceId))
    );

    expect(gone).toEqual(tables.map((table) => ({ rows: 0, table })));
    // Alpha is untouched - two channels, since one of them is the bridged one.
    expect(kept).toEqual(
      tables.map((table) => ({ rows: table === "channels" ? 2 : 1, table }))
    );

    // The children of those roots go too - by cascade for messages, by hand
    // for the tables that have no foreign key.
    const messages = await d1
      .prepare("SELECT id FROM messages WHERE id = ?")
      .bind(beta.messageId)
      .all();
    expect(messages.results).toHaveLength(0);
    const attachments = await d1
      .prepare("SELECT id FROM attachments WHERE id = ?")
      .bind(beta.attachmentId)
      .all();
    expect(attachments.results).toHaveLength(0);
    const skillVersions = await d1
      .prepare("SELECT id FROM skill_versions")
      .bind()
      .all();
    expect(skillVersions.results).toHaveLength(1);
    const runs = await d1
      .prepare("SELECT routine_id FROM routine_runs")
      .bind()
      .all();
    expect(
      runs.results.map((row) => (row as { routine_id: string }).routine_id)
    ).toEqual([alpha.routineId]);
  });

  test("takes its R2 objects with it, and none of the other workspace's", async () => {
    // Attachment, wiki asset, skill file and browser screenshot: every kind of
    // object a workspace stores, and each keyed by nothing that names the
    // workspace - so the keys have to be read off the rows before they go.
    expect(beta.r2Keys.length).toBeGreaterThan(3);

    await deleteWorkspace(db, bucket, beta.workspaceId);

    const remaining = [...r2Objects.keys()];
    for (const key of beta.r2Keys) {
      expect(remaining).not.toContain(key);
    }
    for (const key of alpha.r2Keys) {
      expect(remaining).toContain(key);
    }
  });

  test("takes the bridge refs naming its messages, and leaves the global Slack caches", async () => {
    // Neither of these belongs to a tenant: the dedupe is keyed by Slack's own
    // event id, and one Slack user posts through more than one workspace.
    await claimSlackKey(db, "Ev0DEDUPE");
    await d1
      .prepare(
        "INSERT INTO slack_users (user_id, display_name) VALUES ('U0SHARED', 'Grace')"
      )
      .bind()
      .run();

    await deleteWorkspace(db, bucket, beta.workspaceId);

    expect(
      await findInternalId(db, "slack", "message", beta.externalMessageId)
    ).toBeUndefined();
    expect(
      await findInternalId(db, "slack", "message", alpha.externalMessageId)
    ).toBe(alpha.messageId);

    const seen = await d1
      .prepare("SELECT event_id FROM slack_events_seen")
      .bind()
      .all();
    expect(seen.results).toHaveLength(1);
    const users = await d1
      .prepare("SELECT user_id FROM slack_users")
      .bind()
      .all();
    expect(users.results).toHaveLength(1);
  });

  test("a member of the deleted workspace can no longer reach it", async () => {
    await deleteWorkspace(db, bucket, beta.workspaceId);
    const response = await request("/api/w/beta/agents", { as: BOB_ID });
    expect(response.status).toBe(404);
  });
});
