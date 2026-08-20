import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { decryptSecret, generateConnectorKey } from "#/crypto";
import type { Db } from "#/db/client";
import { createAgent } from "#/modules/agents/service";
import { createChannel } from "#/modules/messaging/service";
import { createWorkspace } from "#/modules/workspaces/service";
import { upsertBridge } from "../bridges";
import { channelBridges, slackApps } from "../schema";
import {
  createDraftSlackApp,
  deleteSlackApp,
  getSlackAppForAgent,
  listSlackApps,
  SlackAppExistsError,
  slackAppCredentials,
  slackAppSigningSecret,
  storeSlackAppTokens,
  toSlackAppView,
} from "./apps";

/**
 * The connection lifecycle against a real database - the shipped migrations in
 * an in-memory SQLite - with Slack's `auth.test` faked. What is being pinned
 * down: a draft holds no credentials, a verified token records who it belongs
 * to, a refused one leaves Slack's own error behind, and nothing that leaves
 * this module ever carries a token.
 */

const KEY = generateConnectorKey();
const BOT_TOKEN = "xoxb-1111-2222-abcdefghijklmnop";
const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

const migrate = (): Db => {
  const dir = new URL("../../../../drizzle/", import.meta.url);
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", dir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`${entry.tag}.sql`, dir), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.run(statement);
    }
  }
  return drizzle(sqlite) as unknown as Db;
};

/** `auth.test`, answered the way Slack answers it. */
const authTestFetch = (payload: Record<string, unknown>): typeof fetch =>
  ((url: string) => {
    if (!String(url).endsWith("/auth.test")) {
      throw new Error(`Unexpected call to ${url}`);
    }
    return Promise.resolve(Response.json(payload));
  }) as unknown as typeof fetch;

const okAuthTest = authTestFetch({
  bot_id: "B0AGENTBOT",
  ok: true,
  team: "Rocky Shores",
  team_id: "T0RSL",
  user_id: "U0ADABOT",
});

let db: Db;
let workspaceId: string;
let agentId: string;

beforeEach(async () => {
  db = migrate();
  const { workspace } = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: "user_ada",
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada",
    },
  });
  workspaceId = workspace.id;
  const { agent } = await createAgent(db, workspaceId, {
    instructions: "",
    name: "Ada",
    soul: "",
  });
  agentId = agent.id;
});

describe("createDraftSlackApp", () => {
  test("starts with no credentials, and one app per agent", async () => {
    const app = await createDraftSlackApp(db, workspaceId, agentId);

    expect(app.status).toBe("draft");
    expect(app.botTokenEnc).toBeNull();
    expect(app.signingSecretEnc).toBeNull();
    expect(await slackAppCredentials(KEY, app)).toBeNull();
    expect(await slackAppSigningSecret(KEY, app)).toBeNull();

    expect(createDraftSlackApp(db, workspaceId, agentId)).rejects.toThrow(
      SlackAppExistsError
    );
    expect(await listSlackApps(db, workspaceId)).toHaveLength(1);
  });
});

describe("storeSlackAppTokens", () => {
  test("records who the token belongs to and stores both secrets encrypted", async () => {
    const draft = await createDraftSlackApp(db, workspaceId, agentId);

    const result = await storeSlackAppTokens(
      db,
      KEY,
      draft,
      { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET },
      okAuthTest
    );

    expect(result.ok).toBe(true);
    const app = await getSlackAppForAgent(db, workspaceId, agentId);
    expect(app?.status).toBe("active");
    // `user_id` is the bot's *user* id - the `<@U…>` a mention of it carries -
    // which is why it, and not `bot_id`, is what we keep.
    expect(app?.botUserId).toBe("U0ADABOT");
    expect(app?.teamId).toBe("T0RSL");
    expect(app?.teamName).toBe("Rocky Shores");
    expect(app?.lastError).toBeNull();

    // Encrypted at rest, and readable only through the accessor.
    expect(app?.botTokenEnc).not.toContain("xoxb");
    if (!app) {
      throw new Error("The app disappeared.");
    }
    expect(await decryptSecret(KEY, app.botTokenEnc ?? "")).toBe(BOT_TOKEN);
    expect(await slackAppCredentials(KEY, app)).toEqual({
      botToken: BOT_TOKEN,
      signingSecret: SIGNING_SECRET,
    });
  });

  test("a refused token leaves Slack's error on the row and stores nothing", async () => {
    const draft = await createDraftSlackApp(db, workspaceId, agentId);

    const result = await storeSlackAppTokens(
      db,
      KEY,
      draft,
      { botToken: "xoxb-wrong", signingSecret: SIGNING_SECRET },
      authTestFetch({ error: "invalid_auth", ok: false })
    );

    expect(result).toMatchObject({ error: "invalid_auth", ok: false });
    const app = await getSlackAppForAgent(db, workspaceId, agentId);
    expect(app?.status).toBe("error");
    expect(app?.lastError).toBe("invalid_auth");
    expect(app?.botTokenEnc).toBeNull();
    expect(app?.signingSecretEnc).toBeNull();
  });

  test("an unreachable Slack is a failure, not a crash", async () => {
    const draft = await createDraftSlackApp(db, workspaceId, agentId);

    const result = await storeSlackAppTokens(
      db,
      KEY,
      draft,
      { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET },
      (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch
    );

    expect(result.ok).toBe(false);
    expect((await getSlackAppForAgent(db, workspaceId, agentId))?.status).toBe(
      "error"
    );
  });

  test("a second paste after a failure connects the app", async () => {
    const draft = await createDraftSlackApp(db, workspaceId, agentId);
    const failed = await storeSlackAppTokens(
      db,
      KEY,
      draft,
      { botToken: "xoxb-wrong", signingSecret: SIGNING_SECRET },
      authTestFetch({ error: "invalid_auth", ok: false })
    );

    const retried = await storeSlackAppTokens(
      db,
      KEY,
      failed.app,
      { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET },
      okAuthTest
    );

    expect(retried.ok).toBe(true);
    expect(retried.app.status).toBe("active");
    expect(retried.app.lastError).toBeNull();
  });
});

describe("toSlackAppView", () => {
  test("carries no token field, under any name", async () => {
    const draft = await createDraftSlackApp(db, workspaceId, agentId);
    const { app } = await storeSlackAppTokens(
      db,
      KEY,
      draft,
      { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET },
      okAuthTest
    );

    const view = toSlackAppView(app);
    const serialized = JSON.stringify(view);

    expect(Object.keys(view).sort()).toEqual([
      "agentId",
      "botUserId",
      "createdAt",
      "id",
      "lastError",
      "status",
      "teamId",
      "teamName",
      "updatedAt",
    ]);
    expect(serialized).not.toContain("xoxb");
    expect(serialized).not.toContain(SIGNING_SECRET);
    expect(serialized).not.toContain(app.botTokenEnc ?? "never");
  });
});

describe("deleteSlackApp", () => {
  test("takes the bridges that spoke through it", async () => {
    const app = await createDraftSlackApp(db, workspaceId, agentId);
    const channel = await createChannel(db, workspaceId, { name: "ops" });
    await upsertBridge(db, workspaceId, {
      agentId,
      channelId: channel.id,
      connector: "slack",
      externalChannelId: "C0OPSCHAN",
      slackAppId: app.id,
    });

    await deleteSlackApp(db, app);

    expect(
      await db.select().from(slackApps).where(eq(slackApps.id, app.id))
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(channelBridges)
        .where(eq(channelBridges.slackAppId, app.id))
    ).toHaveLength(0);
  });
});
