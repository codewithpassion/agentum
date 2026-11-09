import { afterEach, beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import type { Fetcher } from "@repo/services/connectors/mcp";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import {
  type StubMcp,
  startStubMcp,
} from "../../../../../scripts/dev/stub-mcp.ts";
import { composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ORG_IDS = ["org_a"];
const PUBLIC_ORIGIN = "https://mcp.stub-test.com";
const TOKEN = "router-test-token-0123456789";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(5)).toString("base64");

let db: ReturnType<typeof migrated>;
let stub: StubMcp;

beforeEach(() => {
  db = migrated(ORG_IDS);
  stub = startStubMcp({ token: TOKEN });
});

afterEach(() => {
  stub.stop();
});

const toStub: Fetcher = (input, init) =>
  fetch(String(input).replace(PUBLIC_ORIGIN, new URL(stub.url).origin), init);

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
    fetch: toStub,
    fileBlobs: memoryFileBlobs(),
    relay: noopRelay,
    secretsKey: SECRETS_KEY,
  };
};

const callerFor = async (session: {
  orgId?: string | null;
  userId: string | null;
}) =>
  appRouter.createCaller(
    await buildContext({
      composed: composeWith({
        db,
        infra: infra(),
      }),
      session,
    })
  );

test("no tRPC response carries the stored header value", async () => {
  const value = `Bearer ${TOKEN}`;
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create({
    model: "claude-sonnet",
    name: "Bruce",
    runtime: "fake",
  });

  const connector = await caller.connectors.create({
    name: "Stub",
    url: `${PUBLIC_ORIGIN}/mcp`,
  });
  expect(connector.authKind).toBe("header");
  const asUser = await caller.connectors.setCredential({
    connectorId: connector.id,
    value,
  });
  const asAgent = await caller.connectors.setCredential({
    agentId: agent.id,
    connectorId: connector.id,
    value,
  });
  const assigned = await caller.connectors.assign({
    agentId: agent.id,
    connectorId: connector.id,
  });
  const listed = await caller.connectors.list();
  const assignments = await caller.connectors.assignments({
    agentId: agent.id,
  });
  const refused = await caller.connectors
    .setCredential({ connectorId: connector.id, value: `${value}-wrong` })
    .catch((error: unknown) => error);

  expect(asUser.ownerKind).toBe("user");
  expect(asAgent.ownerKind).toBe("agent");
  expect(listed[0]?.tools.map((tool) => tool.name)).toEqual(["echo"]);
  expect(refused).toMatchObject({ code: "BAD_REQUEST" });
  const everything = JSON.stringify([
    connector,
    asUser,
    asAgent,
    assigned,
    listed,
    assignments,
    refused instanceof Error ? refused.message : refused,
  ]);
  expect(everything).not.toContain(TOKEN);
  expect(everything).not.toContain('"secret":');
});

test("a private IP URL is refused with a BAD_REQUEST", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(
    caller.connectors.create({ name: "Bad", url: "https://10.0.0.5/mcp" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(caller.connectors.list()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.connectors.create({ name: "x", url: `${PUBLIC_ORIGIN}/mcp` })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("a connector's call time limit defaults to 60 and setCallTimeout stores a new one", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const connector = await caller.connectors.create({
    name: "Slow",
    url: `${PUBLIC_ORIGIN}/mcp`,
  });
  expect((await caller.connectors.list())[0]?.callTimeoutSeconds).toBe(60);

  const updated = await caller.connectors.setCallTimeout({
    connectorId: connector.id,
    seconds: 120,
  });

  expect(updated).toMatchObject({ callTimeoutSeconds: 120, id: connector.id });
  expect((await caller.connectors.list())[0]?.callTimeoutSeconds).toBe(120);
});

test("setCallTimeout refuses a limit outside 10 to 300 and changes nothing", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const connector = await caller.connectors.create({
    name: "Bounded",
    url: `${PUBLIC_ORIGIN}/mcp`,
  });

  await Promise.all(
    [9, 301].map((seconds) =>
      expect(
        caller.connectors.setCallTimeout({ connectorId: connector.id, seconds })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    )
  );
  expect((await caller.connectors.list())[0]?.callTimeoutSeconds).toBe(60);
});
