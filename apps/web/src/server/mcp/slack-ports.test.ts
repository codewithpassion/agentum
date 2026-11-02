import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { slackApps } from "@repo/db/schema/slack";
import { identityLinks } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import type { SlackDestinations, SlackSendResult } from "@repo/mcp/ports";
import { createHarbourmasterMcpServer } from "@repo/mcp/server";
import { connectClient } from "@repo/mcp/testing";
import { isReadOnly } from "@repo/services/automation-access";
import type { Fetcher } from "@repo/services/connectors/mcp";
import { encryptSecret, importSecretsKey } from "@repo/services/crypto";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { slackSecretBinding } from "@repo/services/slack/apps";
import { type Principal, SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { type Composed, composeWith } from "../compose.ts";
import { createMcpPorts } from "./ports.ts";

const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
const TEAM = "T0TEAM";
const ANN_EMAIL = "ann@example.test";
const ANN_USER = "U0ANN12345";
const ANN_DM = "D0ANN";
const GENERAL = "C0GENERAL";
const SENT_TS = "1700000001.000100";
const SENT_TEXT = "Hello team";
const SEND_TOOLS = ["slack_destinations", "slack_send"];

let composed: Composed;
let db: Composed["db"];
let workspaceId: string;
let userPrincipal: Principal;
let posts: { channel: unknown; text: unknown }[];

const jsonResponse = (body: object) => Promise.resolve(Response.json(body));

/** Answers the Slack methods the send path calls, and records each post. */
const slackFetch: Fetcher = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = url.pathname.slice("/api/".length);
  const body =
    typeof init?.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : {};
  switch (method) {
    case "users.conversations":
      return jsonResponse({
        channels: [{ id: GENERAL, is_private: false, name: "general" }],
        ok: true,
      });
    case "users.info":
      return jsonResponse({
        ok: true,
        user: { profile: { real_name: "Ann Lee" } },
      });
    case "conversations.open":
      return jsonResponse({ channel: { id: ANN_DM }, ok: true });
    case "chat.postMessage":
      posts.push({ channel: body.channel, text: body.text });
      return jsonResponse({ channel: body.channel, ok: true, ts: SENT_TS });
    case "chat.getPermalink":
      return jsonResponse({
        ok: true,
        permalink: `https://acme.slack.com/archives/${GENERAL}/p${SENT_TS}`,
      });
    default:
      return jsonResponse({ error: method, ok: false });
  }
};

/** An MCP session for `principal`, with the tools that principal may see. */
const connect = async (principal: Principal) => {
  const ports = createMcpPorts({ principal, services: composed.services });
  const server = createHarbourmasterMcpServer(ports, {
    readOnly: isReadOnly(principal),
  });
  const { client, close } = await connectClient(server);
  return {
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ arguments: args, name }),
    close,
    listToolNames: async () =>
      (await client.listTools()).tools.map((tool) => tool.name),
  };
};

type Result = Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["call"]>>;

const dataOf = (result: Result): Record<string, unknown> =>
  (result.structuredContent ?? {}) as Record<string, unknown>;

const textOf = (result: Result): string =>
  (result.content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");

const makeAgent = (name: string) =>
  composed.services.agents.create(userPrincipal, {
    model: "fake",
    name,
    runtime: "fake",
  });

/** A run of `agentId`, as the principal its tools are called as. */
const runAs = async (agentId: string): Promise<Principal> => {
  const { runId } = await composed.services.runs.startRun(
    userPrincipal,
    {
      agentId,
      input: { text: "x" },
      session: { origin: "mcp" },
    },
    { offerLater: true }
  );
  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  return { agentId, kind: "run", runId, workspaceId };
};

/** An installed Slack app for `agentId`, with an encrypted bot token. */
const installSlackApp = async (agentId: string, appId: string) => {
  const key = await importSecretsKey(SECRETS_KEY);
  const ref = { id: appId, workspaceId };
  db.insert(slackApps)
    .values({
      agentId,
      appId: "A0APP",
      botToken: await encryptSecret(
        key,
        slackSecretBinding(ref, "bot_token"),
        "xoxb-test"
      ),
      botUserId: "U0BOT",
      createdAt: new Date().toISOString(),
      id: appId,
      signingSecret: await encryptSecret(
        key,
        slackSecretBinding(ref, "signing_secret"),
        "signing-test"
      ),
      status: "installed",
      teamId: TEAM,
      workspaceId,
    })
    .run();
};

beforeEach(async () => {
  db = migrated(["org_a"]);
  const store = new Map<string, string>();
  posts = [];
  composed = composeWith({
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
      fetch: slackFetch,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
      secretsKey: SECRETS_KEY,
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("the test organisation is not allowed");
  }
  workspaceId = workspace.id;
  userPrincipal = {
    kind: "user",
    userId: "user_1",
    via: "session",
    workspaceId,
  };
  db.insert(identityLinks)
    .values({
      clerkUserId: "user_ann",
      createdAt: new Date().toISOString(),
      email: ANN_EMAIL,
      externalUserId: ANN_USER,
      id: "il1",
      provider: "slack",
      teamId: TEAM,
      workspaceId,
    })
    .run();
});

test("slack_destinations lists the bot's channels and the linked people", async () => {
  const agent = await makeAgent("Echo");
  await installSlackApp(agent.id, "sa1");
  const session = await connect(await runAs(agent.id));

  const result = await session.call("slack_destinations", {});

  expect(result.isError).toBeFalsy();
  expect(dataOf(result)).toEqual({
    channels: [
      {
        id: GENERAL,
        isPrivate: false,
        mention: `<#${GENERAL}>`,
        name: "general",
      },
    ],
    people: [
      {
        email: ANN_EMAIL,
        mention: `<@${ANN_USER}>`,
        slackName: "Ann Lee",
        slackUserId: ANN_USER,
      },
    ],
  } satisfies SlackDestinations);
  await session.close();
});

test("slack_send posts to a channel and to a person, and returns channel and ts", async () => {
  const agent = await makeAgent("Echo");
  await installSlackApp(agent.id, "sa1");
  const session = await connect(await runAs(agent.id));

  const toChannel = await session.call("slack_send", {
    text: SENT_TEXT,
    to: "#general",
  });
  expect(toChannel.isError).toBeFalsy();
  expect(dataOf(toChannel)).toEqual({
    channel: GENERAL,
    notes: [],
    permalink: `https://acme.slack.com/archives/${GENERAL}/p${SENT_TS}`,
    to: "#general",
    ts: SENT_TS,
  } satisfies SlackSendResult);

  const toPerson = await session.call("slack_send", {
    text: "Hi Ann",
    to: ANN_EMAIL,
  });
  expect(toPerson.isError).toBeFalsy();
  expect(dataOf(toPerson)).toMatchObject({ channel: ANN_DM, to: ANN_EMAIL });

  expect(posts).toEqual([
    { channel: GENERAL, text: SENT_TEXT },
    { channel: ANN_DM, text: "Hi Ann" },
  ]);
  await session.close();
});

test("slack_send from an agent with no Slack app is an error that says so", async () => {
  const agent = await makeAgent("Quiet");
  const session = await connect(await runAs(agent.id));

  const result = await session.call("slack_send", {
    text: SENT_TEXT,
    to: "#general",
  });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("no Slack app installed");
  expect(posts).toHaveLength(0);
  await session.close();
});

test("slack_send from a person, not an agent run, is an error result", async () => {
  const session = await connect(userPrincipal);

  const result = await session.call("slack_send", {
    text: SENT_TEXT,
    to: "#general",
  });

  expect(result.isError).toBe(true);
  expect(dataOf(result).code).toBe("validation");
  expect(posts).toHaveLength(0);
  await session.close();
});

test("a read-only principal does not see the Slack tools, and a person does", async () => {
  const readOnly: Principal = {
    apiKey: { access: "read", id: "k1" },
    kind: "user",
    userId: "user_1",
    via: "api_key",
    workspaceId,
  };

  const reader = await connect(readOnly);
  const readerNames = await reader.listToolNames();
  for (const name of SEND_TOOLS) {
    expect(readerNames).not.toContain(name);
  }
  await reader.close();

  const person = await connect(userPrincipal);
  const personNames = await person.listToolNames();
  for (const name of SEND_TOOLS) {
    expect(personNames).toContain(name);
  }
  await person.close();
});
