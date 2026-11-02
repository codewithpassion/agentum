import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { composeWith } from "./compose.ts";

const CARD_URL = "https://peer.test/.well-known/agent-card.json";
const card = {
  capabilities: { pushNotifications: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  description: "Hermes on Sam's box",
  name: "Hermes",
  securitySchemes: { bearer: { scheme: "bearer", type: "http" } },
  skills: [{ description: "Does things", id: "s", name: "s", tags: ["t"] }],
  supportedInterfaces: [
    {
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
      url: "https://peer.test/a2a",
    },
  ],
  version: "1.0.0",
};

const admin: Principal = {
  isAdmin: true,
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
};

const LOCAL_CARD_URL = "http://localhost:3001/.well-known/agent-card.json";
const localCard = {
  ...card,
  supportedInterfaces: [
    {
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
      url: "http://localhost:3001/a2a",
    },
  ],
};

const build = async (devFakeRuntime: boolean, answer: unknown = card) => {
  const db = migrated();
  await db.insert(workspaces).values({
    clerkOrgId: "org_w1",
    createdAt: new Date().toISOString(),
    id: "w1",
    name: "One",
    timezone: "UTC",
  });
  const fetched: string[] = [];
  const store = new Map<string, string>();
  const { services } = composeWith({
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
      devFakeRuntime,
      fileBlobs: memoryFileBlobs(),
      peerFetch: (url) => {
        fetched.push(url);
        return Promise.resolve(Response.json(answer));
      },
      publicBaseUrl: "https://hm.test",
      relay: noopRelay,
      secretsKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    },
  });
  const agent = await services.agents.create(admin, {
    model: "m",
    name: "Alpha",
    runtime: "cloud",
  });
  return { agent, fetched, services };
};

test("'Call it' reads the card through the real transport, which is the injected peer fetch", async () => {
  const { agent, fetched, services } = await build(false);

  const connection = await services.connections.addOutbound(admin, {
    agentId: agent.id,
    cardUrl: CARD_URL,
    credential: "peer-token",
  });

  expect(fetched).toEqual([CARD_URL]);
  expect(connection).toMatchObject({
    peerKind: "a2a_outbound",
    peerLabel: "Hermes",
    peerOrigin: "https://peer.test",
    status: "active",
  });
});

test("a production composition refuses an agent on localhost over plain http, a dev one takes it", async () => {
  const production = await build(false, localCard);
  await expect(
    production.services.connections.addOutbound(admin, {
      agentId: production.agent.id,
      cardUrl: LOCAL_CARD_URL,
      credential: "peer-token",
    })
  ).rejects.toThrow("That URL is not allowed");
  expect(production.fetched).toEqual([]);

  const dev = await build(true, localCard);
  const connection = await dev.services.connections.addOutbound(admin, {
    agentId: dev.agent.id,
    cardUrl: LOCAL_CARD_URL,
    credential: "peer-token",
  });
  expect(connection).toMatchObject({
    peerOrigin: "http://localhost:3001",
    status: "active",
  });
});
