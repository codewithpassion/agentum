import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { identityLinks } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { composeWith, type Infra } from "./compose.ts";

const TOKEN = "xoxb-1-2-needsauth";
const SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(5)).toString("base64");

let db: ReturnType<typeof migrated>;
let posted: { method: string; body: Record<string, unknown> }[];

beforeEach(() => {
  db = migrated(["org_a"]);
  posted = [];
});

/** A Slack that knows one bot token and records what it is asked to post. */
const fakeSlack: Infra["fetch"] = (input, init) => {
  const url = String(input);
  const method = url.split("/api/")[1]?.split("?")[0] ?? url;
  const body: unknown =
    typeof init?.body === "string" ? JSON.parse(init.body) : {};
  posted.push({ body: body as Record<string, unknown>, method });
  if (method === "auth.test") {
    return Promise.resolve(
      Response.json({ bot_id: "B1", ok: true, team_id: "T1", user_id: "U1" })
    );
  }
  if (method === "bots.info") {
    return Promise.resolve(
      Response.json({ bot: { app_id: "A1", id: "B1" }, ok: true })
    );
  }
  return Promise.resolve(Response.json({ ok: true, ts: "1.5" }));
};

test("a connector.needs_auth event appended for a Slack thread sends one private Connect message to the owner", async () => {
  const store = new Map<string, string>();
  const composed = composeWith({
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
      clock: systemClock,
      devFakeRuntime: true,
      fetch: fakeSlack,
      fileBlobs: memoryFileBlobs(),
      publicBaseUrl: "https://hm.example.test",
      relay: noopRelay,
      secretsKey: SECRETS_KEY,
    },
  });
  const { services } = composed;
  const principal = await services.workspaces.sessionPrincipal({
    orgId: "org_a",
    userId: "user_1",
  });
  if (principal?.kind !== "user") {
    throw new Error("Expected a user principal");
  }
  const agent = await services.agents.create(principal, {
    model: "m",
    name: "Echo",
    runtime: "fake",
  });
  await services.slackApps.paste(principal, {
    agentId: agent.id,
    botToken: TOKEN,
    signingSecret: SIGNING_SECRET,
  });
  await db.insert(identityLinks).values({
    clerkUserId: "user_1",
    createdAt: new Date().toISOString(),
    email: "a@example.test",
    externalUserId: "U0PERSON",
    id: "link1",
    provider: "slack",
    teamId: "T1",
    workspaceId: principal.workspaceId,
  });
  const started = await services.runs.startRun(
    { ...principal, via: "slack" },
    {
      agentId: agent.id,
      input: { text: "hello" },
      reply: {
        channel: "C1",
        kind: "slack",
        teamId: "T1",
        threadTs: "1700000000.000100",
      },
      session: { externalKey: "T1:C1:1700000000.000100", origin: "slack" },
    }
  );
  posted.length = 0;

  const event = {
    actor: { id: agent.id, kind: "agent" },
    agentId: agent.id,
    payload: {
      cause: "missing",
      connectorId: "c1",
      connectPath: "/connect/c1?as=user",
      ownerId: "user_1",
      ownerKind: "user",
    },
    runId: started.runId,
    type: "connector.needs_auth",
    workspaceId: principal.workspaceId,
  } as const;
  await services.events.append(event);
  await services.events.append(event);

  const ephemerals = posted.filter(
    (call) => call.method === "chat.postEphemeral"
  );
  expect(ephemerals).toHaveLength(1);
  expect(ephemerals[0]?.body).toMatchObject({
    channel: "C1",
    thread_ts: "1700000000.000100",
    user: "U0PERSON",
  });
  expect(String(ephemerals[0]?.body.text)).toContain(
    "https://hm.example.test/connect/c1?as=user"
  );
});
