import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { slackApps } from "@repo/db/schema/slack";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { and, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { createEventsService, type EventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import { createSecretReader, findAppByApiId } from "./slack/apps.ts";
import type { SlackFetch } from "./slack/client.ts";
import { createSlackAppsService, type SlackAppsService } from "./slack-apps.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const START = "2026-10-16T10:00:00.000Z";
const BASE_URL = "https://hm.example.test";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

const TOKEN = "xoxb-111-222-abcdef";
const OTHER_TOKEN = "xoxb-333-444-ghijkl";
const SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "fedcba9876543210fedcba9876543210";
const SLACK_API = "https://slack.com/api/";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const outsider: Principal = {
  kind: "user",
  userId: "u9",
  via: "session",
  workspaceId: OTHER_WORKSPACE,
};
const fromSlack: Principal = { ...user, via: "slack" };

/** What the fake Slack knows about a token. */
interface Identity {
  appId: string;
  botId: string | null;
  teamId: string;
  userId: string;
}

const IDENTITIES: Record<string, Identity> = {
  [OTHER_TOKEN]: {
    appId: "A0OTHER",
    botId: "B0OTHER",
    teamId: "T0TEAM",
    userId: "U0OTHER",
  },
  [TOKEN]: {
    appId: "A0APP",
    botId: "B0APP",
    teamId: "T0TEAM",
    userId: "U0BOT",
  },
  "xoxb-5-5-nobot": {
    appId: "A0NOBOT",
    botId: null,
    teamId: "T0TEAM",
    userId: "U0NOBOT",
  },
};

type Db = ReturnType<typeof migrated>;

let db: Db;
let clock: Clock;
let events: EventsService;
let agents: AgentsService;
let service: SlackAppsService;
let agentId: string;
let secondAgentId: string;
let slackCalls: { token: string | null; url: string }[];

const json = (body: unknown) => Response.json(body);

/** Answers `auth.test` and `bots.info` from `IDENTITIES`, like Slack would. */
const fakeSlack: SlackFetch = (url, init) => {
  const headers = new Headers(init.headers);
  const token = headers.get("Authorization")?.replace("Bearer ", "") ?? null;
  slackCalls.push({ token, url });
  const identity = token ? IDENTITIES[token] : undefined;
  if (!identity) {
    return Promise.resolve(json({ error: "invalid_auth", ok: false }));
  }
  if (url.startsWith(`${SLACK_API}auth.test`)) {
    return Promise.resolve(
      json({
        bot_id: identity.botId ?? undefined,
        ok: true,
        team_id: identity.teamId,
        user_id: identity.userId,
      })
    );
  }
  if (url.startsWith(`${SLACK_API}bots.info`)) {
    return Promise.resolve(
      json({ bot: { app_id: identity.appId, id: identity.botId }, ok: true })
    );
  }
  return Promise.resolve(json({ error: "unknown_method", ok: false }));
};

const insertWorkspace = (id: string) =>
  db
    .insert(workspaceRows)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: START,
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

const build = (
  extra: { publicBaseUrl?: string; secretsKey?: string } = {
    publicBaseUrl: BASE_URL,
    secretsKey: SECRETS_KEY,
  }
) =>
  createSlackAppsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    fetch: fakeSlack,
    ...extra,
  });

const appRows = () => db.select().from(slackApps).all();

const eventTypes = (type: "slack.app_installed" | "slack.app_revoked") =>
  db.select().from(eventRows).where(eq(eventRows.type, type)).all();

beforeEach(async () => {
  db = migrated();
  slackCalls = [];
  clock = { now: () => new Date(START), sleep: () => Promise.resolve() };
  insertWorkspace(WORKSPACE);
  insertWorkspace(OTHER_WORKSPACE);
  events = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
  agents = createAgentsService({ db, events });
  agentId = (
    await agents.create(user, {
      model: "m",
      name: "Q3 Report Bot",
      runtime: "fake",
    })
  ).id;
  secondAgentId = (
    await agents.create(user, { model: "m", name: "Second", runtime: "fake" })
  ).id;
  service = build();
});

const SECRET_KEYS = ["botToken", "signingSecret", "clientSecret", "clientId"];

test("manifest is built from the agent and the public address", async () => {
  const { filename, json: text } = await service.manifest(user, { agentId });
  const manifest = JSON.parse(text);

  expect(filename.endsWith("-slack-manifest.json")).toBe(true);
  expect(manifest.display_information.name).toBe("Q3 Report Bot");
  expect(manifest.features.bot_user.display_name).toBe("q3-report-bot");
  expect(manifest.features.agent_view.agent_description).toContain(
    "Q3 Report Bot"
  );
  expect(manifest.settings.event_subscriptions.request_url).toBe(
    `${BASE_URL}/api/slack/events`
  );
  expect(manifest.oauth_config.scopes.bot).toContain("app_mentions:read");
});

test("manifest refuses an agent of another workspace, and a missing public address", async () => {
  await expect(service.manifest(outsider, { agentId })).rejects.toBeInstanceOf(
    ServiceError
  );
  await expect(
    build({ secretsKey: SECRETS_KEY }).manifest(user, { agentId })
  ).rejects.toMatchObject({ code: "invalid" });
});

test("paste checks the token with Slack, stores both secrets encrypted and installs the app", async () => {
  const summary = await service.paste(user, {
    agentId,
    botToken: TOKEN,
    signingSecret: SIGNING_SECRET,
  });

  expect(summary).toEqual({
    agentId,
    appId: "A0APP",
    botUserId: "U0BOT",
    createdAt: START,
    id: summary.id,
    status: "installed",
    teamId: "T0TEAM",
  });
  expect(slackCalls.map((call) => call.token)).toEqual([TOKEN, TOKEN]);

  const [row] = appRows();
  expect(row?.botToken).not.toContain("xoxb");
  expect(row?.signingSecret).not.toContain(SIGNING_SECRET);
  const found = await findAppByApiId(db, "A0APP");
  expect(found?.id).toBe(summary.id);
  const secrets = createSecretReader(SECRETS_KEY);
  if (!found) {
    throw new Error("Expected the app to be found");
  }
  expect(await secrets.botToken(found)).toBe(TOKEN);
  expect(await secrets.signingSecret(found)).toBe(SIGNING_SECRET);

  const [event] = eventTypes("slack.app_installed");
  expect(event?.actorId).toBe("u1");
  expect(event?.payload).not.toContain("xoxb");
  expect(event?.payload).not.toContain(SIGNING_SECRET);
});

test("list returns summaries with no secret field, only for the agent's own workspace", async () => {
  await service.paste(user, {
    agentId,
    botToken: TOKEN,
    signingSecret: SIGNING_SECRET,
  });

  const listed = await service.list(user, { agentId });
  expect(listed).toHaveLength(1);
  for (const key of SECRET_KEYS) {
    expect(listed[0]).not.toHaveProperty(key);
  }
  expect(JSON.stringify(listed)).not.toContain("xoxb");
  expect(await service.list(user, { agentId: secondAgentId })).toEqual([]);
  expect(await service.list(outsider, { agentId })).toEqual([]);
});

test("a token Slack refuses, a user token and a bad shape store nothing", async () => {
  await expect(
    service.paste(user, {
      agentId,
      botToken: "xoxb-9-9-unknown",
      signingSecret: SIGNING_SECRET,
    })
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    service.paste(user, {
      agentId,
      botToken: "xoxb-5-5-nobot",
      signingSecret: SIGNING_SECRET,
    })
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    service.paste(user, {
      agentId,
      botToken: "xoxp-user-token",
      signingSecret: SIGNING_SECRET,
    })
  ).rejects.toBeInstanceOf(ZodError);
  await expect(
    service.paste(user, { agentId, botToken: TOKEN, signingSecret: "short" })
  ).rejects.toBeInstanceOf(ZodError);

  expect(appRows()).toHaveLength(0);
  expect(eventTypes("slack.app_installed")).toHaveLength(0);
});

test("a refusal from Slack does not echo the pasted token", async () => {
  const error = await service
    .paste(user, {
      agentId,
      botToken: "xoxb-9-9-unknown",
      signingSecret: SIGNING_SECRET,
    })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).message).not.toContain("xoxb-9-9-unknown");
});

test("pasting again for the same agent and Slack workspace replaces the secrets", async () => {
  const first = await service.paste(user, {
    agentId,
    botToken: TOKEN,
    signingSecret: SIGNING_SECRET,
  });
  const second = await service.paste(user, {
    agentId,
    botToken: OTHER_TOKEN,
    signingSecret: OTHER_SECRET,
  });

  expect(second.id).toBe(first.id);
  expect(second.appId).toBe("A0OTHER");
  expect(appRows()).toHaveLength(1);
  const found = await findAppByApiId(db, "A0OTHER");
  if (!found) {
    throw new Error("Expected the app to be found");
  }
  const secrets = createSecretReader(SECRETS_KEY);
  expect(await secrets.botToken(found)).toBe(OTHER_TOKEN);
  expect(await secrets.signingSecret(found)).toBe(OTHER_SECRET);
  expect(await findAppByApiId(db, "A0APP")).toBeNull();
});

test("a Slack app already connected to another agent is a conflict", async () => {
  await service.paste(user, {
    agentId,
    botToken: TOKEN,
    signingSecret: SIGNING_SECRET,
  });

  await expect(
    service.paste(user, {
      agentId: secondAgentId,
      botToken: TOKEN,
      signingSecret: SIGNING_SECRET,
    })
  ).rejects.toMatchObject({ code: "conflict" });
  expect(appRows()).toHaveLength(1);
});

test("revoke stops the app, deletes the bot token and records an event", async () => {
  const { id } = await service.paste(user, {
    agentId,
    botToken: TOKEN,
    signingSecret: SIGNING_SECRET,
  });

  const revoked = await service.revoke(user, { id });

  expect(revoked.status).toBe("revoked");
  for (const key of SECRET_KEYS) {
    expect(revoked).not.toHaveProperty(key);
  }
  const [row] = appRows();
  expect(row?.status).toBe("revoked");
  expect(row?.botToken).toBeNull();
  expect(await findAppByApiId(db, "A0APP")).toBeNull();
  expect(eventTypes("slack.app_revoked")).toHaveLength(1);

  // A second revoke is not an error and writes no second event.
  expect((await service.revoke(user, { id })).status).toBe("revoked");
  expect(eventTypes("slack.app_revoked")).toHaveLength(1);
});

test("pasting after a revoke brings the same row back", async () => {
  const { id } = await service.paste(user, {
    agentId,
    botToken: TOKEN,
    signingSecret: SIGNING_SECRET,
  });
  await service.revoke(user, { id });

  const again = await service.paste(user, {
    agentId,
    botToken: TOKEN,
    signingSecret: SIGNING_SECRET,
  });

  expect(again.id).toBe(id);
  expect(again.status).toBe("installed");
  const found = await findAppByApiId(db, "A0APP");
  expect(found?.id).toBe(id);
  expect(await createSecretReader(SECRETS_KEY).botToken(found as never)).toBe(
    TOKEN
  );
});

test("revoke does not reach an app of another workspace", async () => {
  const { id } = await service.paste(user, {
    agentId,
    botToken: TOKEN,
    signingSecret: SIGNING_SECRET,
  });

  await expect(service.revoke(outsider, { id })).rejects.toMatchObject({
    code: "not_found",
  });
  const [row] = db
    .select()
    .from(slackApps)
    .where(and(eq(slackApps.id, id)))
    .all();
  expect(row?.status).toBe("installed");
});

test("only a signed-in session manages apps, not a Slack message or a trigger", async () => {
  const trigger: Principal = {
    agentId,
    kind: "trigger",
    triggerId: "t1",
    workspaceId: WORKSPACE,
  };
  const refused = [fromSlack, trigger].flatMap((caller) => [
    service.manifest(caller, { agentId }),
    service.list(caller, { agentId }),
    service.paste(caller, {
      agentId,
      botToken: TOKEN,
      signingSecret: SIGNING_SECRET,
    }),
    service.revoke(caller, { id: "x" }),
  ]);
  const outcomes = await Promise.allSettled(refused);
  for (const outcome of outcomes) {
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(ForbiddenError);
    }
  }
  expect(slackCalls).toHaveLength(0);
});

test("pasting without SECRETS_KEY fails before Slack is called", async () => {
  const unkeyed = build({ publicBaseUrl: BASE_URL });

  await expect(
    unkeyed.paste(user, {
      agentId,
      botToken: TOKEN,
      signingSecret: SIGNING_SECRET,
    })
  ).rejects.toThrow("SECRETS_KEY");
  expect(slackCalls).toHaveLength(0);
  expect(appRows()).toHaveLength(0);
});
