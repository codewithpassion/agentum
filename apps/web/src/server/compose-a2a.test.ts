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

test("'Call it' reads the card through the real transport, which is the injected peer fetch", async () => {
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
    allowedOrgIds: ["org_w1"],
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
      devFakeRuntime: false,
      fileBlobs: memoryFileBlobs(),
      peerFetch: (url) => {
        fetched.push(url);
        return Promise.resolve(Response.json(card));
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
