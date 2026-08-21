import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import { createDb, type Db } from "#/db/client";

/**
 * The wizard API: create a draft, read it back with its manifest, paste the
 * tokens, bridge a channel through the app, disconnect.
 *
 * Every response any of these routes produced is kept and swept at the end:
 * a token that reaches a client once is a token that has leaked, so the check
 * is over whole bodies rather than field by field.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
let signedInAs: string | null = ADA_ID;
mock.module("@clerk/hono", () => ({
  getAuth: () => (signedInAs ? { userId: signedInAs } : null),
}));

const { generateConnectorKey } = await import("#/crypto");
const { createAgent } = await import("#/modules/agents/service");
const { createChannel } = await import("#/modules/messaging/service");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { workspaceScopedRoutes } = await import("#/modules/workspaces/routes");
const { agentsRoutes } = await import("#/modules/agents/routes");
const { agentSlackAppRoutes, bridgeRoutes } = await import("./routes");
const { getSlackAppForAgent } = await import("./slack/apps");
const { slackRoutes } = await import("./slack/routes");

const KEY = generateConnectorKey();
const BOT_TOKEN = "xoxb-4321-fake-bot-token";
const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const PUBLIC_APP_URL = "https://agentum.example.com";
const SLACK_CHANNEL = "C0OPSCHAN";
/** A second Slack channel: one connector channel is never bridged twice. */
const SLACK_CHANNEL_TWO = "C0GRACECHAN";
const NOT_FOUND = 404;

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

/** Slack, narrowed to the two calls the wizard and the bridge form make. */
let slackFailure: string | null = null;
const fakeSlackFetch = ((input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("auth.test")) {
    return Promise.resolve(
      Response.json(
        slackFailure
          ? { error: slackFailure, ok: false }
          : {
              ok: true,
              team: "Rocky Shores",
              team_id: "T0RSL",
              user_id: "U0BOT",
            }
      )
    );
  }
  if (url.includes("conversations.info")) {
    return Promise.resolve(
      Response.json({
        channel: { id: SLACK_CHANNEL, is_member: true, name: "ops" },
        ok: true,
      })
    );
  }
  return Promise.resolve(Response.json({ ok: true }));
}) as unknown as typeof fetch;

workspaceScopedRoutes.route("/agents", agentSlackAppRoutes);
workspaceScopedRoutes.route("/agents", agentsRoutes);
workspaceScopedRoutes.route("/channels", bridgeRoutes);
const app = new Hono<ApiEnv>();
app.route("/api/w/:workspaceSlug", workspaceScopedRoutes);
// Slack's own surface, which carries no session and no workspace in its path.
app.route("/api/bridges/slack", slackRoutes);

/** Every body every route in this file returned, for the sweep at the end. */
let seen: string[] = [];

let db: Db;
let env: Env;
let slug: string;
let workspaceId: string;
let agentId: string;
let channelId: string;

const request = async (
  path: string,
  init: { body?: unknown; method?: string } = {}
): Promise<{ body: string; status: number }> => {
  const response = await app.request(
    `/api/w/${slug}${path}`,
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
  const body = await response.text();
  seen.push(body);
  return { body, status: response.status };
};

const json = <T>(body: string): T => JSON.parse(body) as T;

interface SlackAppBody {
  manifest?: string;
  requestUrl?: string;
  slackApp: { id: string; lastError: string | null; status: string } | null;
}

const createDraft = async () =>
  json<SlackAppBody>(
    (await request(`/agents/${agentId}/slack-app`, { method: "POST" })).body
  );

/** The row as it actually sits in D1, encrypted columns and all. */
const currentApp = async () => {
  const row = await getSlackAppForAgent(db, workspaceId, agentId);
  if (!row) {
    throw new Error("The agent has no Slack app.");
  }
  return row;
};

const pasteTokens = (botToken = BOT_TOKEN) =>
  request(`/agents/${agentId}/slack-app/tokens`, {
    body: { botToken, signingSecret: SIGNING_SECRET },
    method: "PUT",
  });

/** The whole wizard for one agent, which any agent here may need. */
const connectSlackApp = async (id: string): Promise<string> => {
  const draft = json<SlackAppBody>(
    (await request(`/agents/${id}/slack-app`, { method: "POST" })).body
  );
  await request(`/agents/${id}/slack-app/tokens`, {
    body: { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET },
    method: "PUT",
  });
  return draft.slackApp?.id ?? "";
};

const bridgeChannel = (
  channel: string,
  slackAppId: string,
  externalChannelId = SLACK_CHANNEL
) =>
  request(`/channels/${channel}/bridge`, {
    body: { externalChannelId, slackAppId },
    method: "POST",
  });

const bridgeOf = async (channel: string): Promise<unknown> =>
  json<{ bridge: unknown }>((await request(`/channels/${channel}/bridge`)).body)
    .bridge;

/**
 * The URL Slack posts to, which knows no workspace and carries no session: an
 * app that is gone answers 404 there, whoever asks.
 */
const postToEventsUrl = async (slackAppId: string): Promise<number> => {
  const response = await app.request(
    `/api/bridges/slack/${slackAppId}`,
    {
      body: JSON.stringify({ type: "event_callback" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    env
  );
  seen.push(await response.text());
  return response.status;
};

beforeEach(async () => {
  seen = [];
  signedInAs = ADA_ID;
  slackFailure = null;
  globalThis.fetch = fakeSlackFetch;

  const d1 = createTestD1();
  db = createDb(d1);
  env = { CONNECTOR_KEY: KEY, DB: d1, PUBLIC_APP_URL } as unknown as Env;

  const { workspace } = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: ADA_ID,
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada",
    },
  });
  const { id, slug: workspaceSlug } = workspace;
  slug = workspaceSlug;
  workspaceId = id;

  const { agent } = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Ada",
    soul: "",
  });
  agentId = agent.id;
  channelId = (await createChannel(db, workspace.id, { name: "ops" })).id;
});

describe("POST /agents/:id/slack-app", () => {
  test("creates a draft, with the manifest that names its own events URL", async () => {
    const created = await createDraft();

    expect(created.slackApp?.status).toBe("draft");
    expect(created.requestUrl).toBe(
      `${PUBLIC_APP_URL}/api/bridges/slack/${created.slackApp?.id}`
    );
    expect(created.manifest).toContain(created.requestUrl ?? "never");
    expect(created.manifest).toContain("app_mentions:read");
  });

  test("refuses a second app for the same agent", async () => {
    await createDraft();
    const again = await request(`/agents/${agentId}/slack-app`, {
      method: "POST",
    });

    expect(again.status).toBe(409);
  });
});

describe("GET /agents/:id/slack-app", () => {
  test("is null before the wizard runs, and hands the manifest back after", async () => {
    const before = json<SlackAppBody>(
      (await request(`/agents/${agentId}/slack-app`)).body
    );
    expect(before.slackApp).toBeNull();

    const created = await createDraft();
    const after = json<SlackAppBody>(
      (await request(`/agents/${agentId}/slack-app`)).body
    );

    expect(after.slackApp?.id).toBe(created.slackApp?.id ?? "");
    expect(after.manifest).toBe(created.manifest ?? "");
  });
});

describe("PUT /agents/:id/slack-app/tokens", () => {
  test("a verified token activates the app and records the installation", async () => {
    await createDraft();
    const response = await pasteTokens();

    expect(response.status).toBe(200);
    const view = json<SlackAppBody>(response.body).slackApp;
    expect(view).toMatchObject({ lastError: null, status: "active" });

    // Stored encrypted, and readable only server-side.
    const stored = await currentApp();
    expect(stored.botTokenEnc).not.toBeNull();
    expect(stored.botTokenEnc).not.toContain("xoxb");
    expect(stored.teamName).toBe("Rocky Shores");
    expect(stored.botUserId).toBe("U0BOT");
  });

  test("a token Slack refuses surfaces Slack's own error", async () => {
    await createDraft();
    slackFailure = "invalid_auth";
    const response = await pasteTokens("xoxb-wrong");

    expect(response.status).toBe(422);
    expect(json<{ error: string }>(response.body).error).toBe("invalid_auth");
    expect(json<SlackAppBody>(response.body).slackApp?.status).toBe("error");

    // And the retry after the fix is accepted.
    slackFailure = null;
    const retried = await pasteTokens();
    expect(json<SlackAppBody>(retried.body).slackApp?.status).toBe("active");
  });
});

describe("bridging through the app", () => {
  test("a draft cannot carry a bridge, a connected app can", async () => {
    const created = await createDraft();
    const slackAppId = created.slackApp?.id ?? "";

    const tooEarly = await request(`/channels/${channelId}/bridge`, {
      body: { externalChannelId: SLACK_CHANNEL, slackAppId },
      method: "POST",
    });
    expect(tooEarly.status).toBe(400);

    await pasteTokens();
    const bridged = await request(`/channels/${channelId}/bridge`, {
      body: { externalChannelId: SLACK_CHANNEL, slackAppId },
      method: "POST",
    });

    expect(bridged.status).toBe(201);
    // The bridge's agent comes from the app: there is no separate choice.
    expect(
      json<{ bridge: { agentId: string; slackAppId: string } }>(bridged.body)
        .bridge
    ).toMatchObject({ agentId, slackAppId });
  });
});

describe("DELETE /agents/:id/slack-app", () => {
  test("disconnects, and takes the bridges that spoke through it", async () => {
    const created = await createDraft();
    await pasteTokens();
    await request(`/channels/${channelId}/bridge`, {
      body: {
        externalChannelId: SLACK_CHANNEL,
        slackAppId: created.slackApp?.id ?? "",
      },
      method: "POST",
    });

    const removed = await request(`/agents/${agentId}/slack-app`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);

    expect(
      json<SlackAppBody>((await request(`/agents/${agentId}/slack-app`)).body)
        .slackApp
    ).toBeNull();
    const bridge = json<{ bridge: unknown }>(
      (await request(`/channels/${channelId}/bridge`)).body
    );
    expect(bridge.bridge).toBeNull();
  });
});

describe("DELETE /agents/:id", () => {
  test("takes the agent's Slack app, its bridges and its events URL with it", async () => {
    const slackAppId = await connectSlackApp(agentId);
    await bridgeChannel(channelId, slackAppId);

    const other = await createAgent(db, workspaceId, {
      instructions: "",
      name: "Grace",
      soul: "",
    });
    const otherAppId = await connectSlackApp(other.agent.id);
    const otherChannelId = (
      await createChannel(db, workspaceId, { name: "grace" })
    ).id;
    await bridgeChannel(otherChannelId, otherAppId, SLACK_CHANNEL_TWO);

    // The events URL answers while the app exists: unsigned, so Slack's own
    // check refuses it - but as this app's URL, not as an unknown one.
    expect(await postToEventsUrl(slackAppId)).not.toBe(NOT_FOUND);

    const removed = await request(`/agents/${agentId}`, { method: "DELETE" });
    expect(removed.status).toBe(204);

    expect(await getSlackAppForAgent(db, workspaceId, agentId)).toBeUndefined();
    expect(await postToEventsUrl(slackAppId)).toBe(NOT_FOUND);
    expect(await bridgeOf(channelId)).toBeNull();

    // The agent that stayed keeps everything it had.
    expect(
      await getSlackAppForAgent(db, workspaceId, other.agent.id)
    ).toBeDefined();
    expect(await postToEventsUrl(otherAppId)).not.toBe(NOT_FOUND);
    expect(await bridgeOf(otherChannelId)).not.toBeNull();
  });
});

describe("no response ever carries a credential", () => {
  test("across every endpoint of the wizard", async () => {
    const created = await createDraft();
    await pasteTokens();
    await request(`/agents/${agentId}/slack-app`);
    await request(`/channels/${channelId}/bridge`, {
      body: {
        externalChannelId: SLACK_CHANNEL,
        slackAppId: created.slackApp?.id ?? "",
      },
      method: "POST",
    });
    await request(`/channels/${channelId}/bridge`);
    await request(`/bridges/bridges?agentId=${agentId}`);
    slackFailure = "invalid_auth";
    await pasteTokens("xoxb-wrong");

    const stored = await currentApp();
    const forbidden = [
      BOT_TOKEN,
      SIGNING_SECRET,
      "xoxb",
      "botToken",
      "signingSecret",
      "botTokenEnc",
      "signingSecretEnc",
      stored.botTokenEnc ?? "unreachable",
      stored.signingSecretEnc ?? "unreachable",
    ];

    const leaked = seen.flatMap((body) =>
      forbidden
        .filter((needle) => body.includes(needle))
        .map((needle) => `${needle} in ${body.slice(0, 80)}`)
    );
    expect(leaked).toEqual([]);
  });
});
