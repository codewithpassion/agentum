import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { slackApps } from "@repo/db/schema/slack";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ORG_IDS = ["org_a", "org_b"];
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
const TOKEN = "xoxb-1-2-routertoken";
const SIGNING_SECRET = "0123456789abcdef0123456789abcdef";

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated(ORG_IDS);
});

const json = (body: unknown) => Response.json(body);

/** A Slack that knows one bot token. */
const fakeSlack: Infra["fetch"] = (input, init) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  if (headers.get("Authorization") !== `Bearer ${TOKEN}`) {
    return Promise.resolve(json({ error: "invalid_auth", ok: false }));
  }
  if (url.includes("auth.test")) {
    return Promise.resolve(
      json({ bot_id: "B1", ok: true, team_id: "T1", user_id: "U1" })
    );
  }
  return Promise.resolve(json({ bot: { app_id: "A1", id: "B1" }, ok: true }));
};

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
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
  };
};

const servicesFor = (): Composed => composeWith({ db, infra: infra() });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = servicesFor()
) => appRouter.createCaller(await buildContext({ composed, session }));

const agentInput = { model: "fake", name: "Echo", runtime: "fake" } as const;

test("paste, list and revoke never send a secret back", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  const pasted = await caller.slackApps.paste({
    agentId: agent.id,
    botToken: TOKEN,
    signingSecret: SIGNING_SECRET,
  });
  const listed = await caller.slackApps.list({ agentId: agent.id });
  const revoked = await caller.slackApps.revoke({ id: pasted.id });
  const manifest = await caller.slackApps.manifest({ agentId: agent.id });

  expect(pasted).toMatchObject({
    appId: "A1",
    status: "installed",
    teamId: "T1",
  });
  expect(listed).toEqual([pasted]);
  expect(revoked.status).toBe("revoked");
  const everything = JSON.stringify({ listed, manifest, pasted, revoked });
  expect(everything).not.toContain(TOKEN);
  expect(everything).not.toContain(SIGNING_SECRET);
  const [row] = db.select().from(slackApps).all();
  expect(everything).not.toContain(row?.signingSecret ?? "missing");
  expect(Object.keys(pasted).sort()).toEqual([
    "agentId",
    "appId",
    "botUserId",
    "createdAt",
    "id",
    "listenMode",
    "status",
    "teamId",
  ]);
});

test("a Slack refusal reaches the caller as BAD_REQUEST with a readable message", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  await expect(
    caller.slackApps.paste({
      agentId: agent.id,
      botToken: "xoxb-9-9-other",
      signingSecret: SIGNING_SECRET,
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("another workspace cannot list, revoke or build a manifest for the app", async () => {
  const composed = servicesFor();
  const owner = await callerFor({ orgId: "org_a", userId: "user_1" }, composed);
  const agent = await owner.agents.create(agentInput);
  const pasted = await owner.slackApps.paste({
    agentId: agent.id,
    botToken: TOKEN,
    signingSecret: SIGNING_SECRET,
  });
  const other = await callerFor({ orgId: "org_b", userId: "user_2" }, composed);

  expect(await other.slackApps.list({ agentId: agent.id })).toEqual([]);
  await expect(other.slackApps.revoke({ id: pasted.id })).rejects.toMatchObject(
    {
      code: "NOT_FOUND",
    }
  );
  await expect(
    other.slackApps.manifest({ agentId: agent.id })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(caller.slackApps.list({ agentId: "x" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.slackApps.paste({
      agentId: "x",
      botToken: TOKEN,
      signingSecret: SIGNING_SECRET,
    })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.slackApps.revoke({ id: "x" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
