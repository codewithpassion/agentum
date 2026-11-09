import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ORG_IDS = ["org_a", "org_b"];
const VALUE = "router-secret-value-01";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated(ORG_IDS);
});

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
    fileBlobs: memoryFileBlobs(),
    relay: noopRelay,
    secretsKey: SECRETS_KEY,
  };
};

const composed = (): Composed => composeWith({ db, infra: infra() });

const callerFor = async (
  session: {
    orgId?: string | null;
    orgRole?: string | null;
    userId: string | null;
  },
  services: Composed
) =>
  appRouter.createCaller(await buildContext({ composed: services, session }));

const rule = {
  header: "Authorization",
  host: "api.openai.com",
  template: "Bearer {value}",
};

test("a signed-out caller is refused", async () => {
  const caller = await callerFor({ userId: null }, composed());
  await expect(caller.secrets.list()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("create, list, replace and delete never show the value", async () => {
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed()
  );
  const created = await caller.secrets.create({
    mode: "proxy",
    name: "OPENAI_API_KEY",
    rules: [rule],
    value: VALUE,
  });
  const replaced = await caller.secrets.update({
    id: created.id,
    patch: { value: "another-secret-value-02" },
  });
  const listed = await caller.secrets.list();
  expect(listed.map((secret) => secret.name)).toEqual(["OPENAI_API_KEY"]);
  for (const read of [created, replaced, listed]) {
    expect(JSON.stringify(read)).not.toContain(VALUE);
    expect(JSON.stringify(read)).not.toContain("another-secret");
  }
  await caller.secrets.remove({ id: created.id });
  expect(await caller.secrets.list()).toEqual([]);
});

test("an admin switches a secret between proxy and env, a member is refused, and nothing shows the value", async () => {
  const services = composed();
  const admin = await callerFor(
    { orgId: "org_a", orgRole: "org:admin", userId: "user_1" },
    services
  );
  const member = await callerFor(
    { orgId: "org_a", orgRole: "org:member", userId: "user_2" },
    services
  );
  const created = await admin.secrets.create({
    mode: "proxy",
    name: "OPENAI_API_KEY",
    rules: [rule],
    value: VALUE,
  });
  const toEnv = await admin.secrets.update({
    id: created.id,
    patch: { allowedHosts: ["api.openai.com"], mode: "env" },
  });
  expect(toEnv).toMatchObject({
    allowedHosts: ["api.openai.com"],
    mode: "env",
    rules: [],
  });
  await expect(
    member.secrets.update({
      id: created.id,
      patch: { mode: "proxy", rules: [rule] },
    })
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const toProxy = await admin.secrets.update({
    id: created.id,
    patch: { mode: "proxy", rules: [rule] },
  });
  expect(toProxy).toMatchObject({ allowedHosts: [], mode: "proxy" });
  expect(JSON.stringify([toEnv, toProxy])).not.toContain(VALUE);
});

test("a reserved name or a bad rule is a BAD_REQUEST", async () => {
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed()
  );
  await expect(
    caller.secrets.create({ mode: "env", name: "SECRETS_KEY", value: VALUE })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.secrets.create({
      mode: "proxy",
      name: "OPENAI_API_KEY",
      rules: [{ ...rule, host: "localhost" }],
      value: VALUE,
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("another workspace sees none of it, and a duplicate name conflicts", async () => {
  const services = composed();
  const first = await callerFor({ orgId: "org_a", userId: "user_1" }, services);
  const other = await callerFor({ orgId: "org_b", userId: "user_2" }, services);
  await first.secrets.create({ mode: "env", name: "PLAIN_KEY", value: VALUE });
  expect(await other.secrets.list()).toEqual([]);
  await expect(
    first.secrets.create({ mode: "env", name: "PLAIN_KEY", value: VALUE })
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

test("grants are set and read per agent", async () => {
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed()
  );
  const agent = await caller.agents.create({
    model: "m",
    name: "Fake",
    runtime: "fake",
  });
  const other = await caller.agents.create({
    model: "m",
    name: "Other",
    runtime: "fake",
  });
  const secret = await caller.secrets.create({
    mode: "env",
    name: "PLAIN_KEY",
    value: VALUE,
  });
  expect(
    await caller.secrets.setGrants({
      agentId: agent.id,
      secretIds: [secret.id],
    })
  ).toEqual([secret.id]);
  expect(await caller.secrets.grants({ agentId: agent.id })).toEqual([
    secret.id,
  ]);
  expect(await caller.secrets.grants({ agentId: other.id })).toEqual([]);
  await expect(
    caller.secrets.setGrants({ agentId: agent.id, secretIds: ["nope"] })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("an invalid name answers the UI with the validation message", async () => {
  const services = composed();
  const response = await fetchRequestHandler({
    createContext: () =>
      buildContext({
        composed: services,
        session: { orgId: "org_a", userId: "user_1" },
      }),
    endpoint: "/api/trpc",
    req: new Request("http://test/api/trpc/secrets.create", {
      body: JSON.stringify({
        mode: "env",
        name: "OPENAI-API-KEY",
        value: VALUE,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    router: appRouter,
  });
  const body = (await response.json()) as { error: { message: string } };
  expect(response.status).toBe(400);
  expect(body.error.message).toBe(
    "A name is letters, digits and underscores, and does not start with a digit"
  );
});
