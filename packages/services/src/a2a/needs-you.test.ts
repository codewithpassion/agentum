import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { createDeskService } from "../desk.ts";
import { createConnectionsService } from "./connections.ts";
import {
  AGENT,
  CONNECTION,
  createFixture,
  type Fixture,
  member,
  peerOf,
  SECRETS_KEY,
  START,
  textMessage,
} from "./tasks-fixture.ts";

const DAY_START = "2026-11-01T00:00:00.000Z";
const LONG_TEXT = "0123456789".repeat(300);
const HERMES = {
  peerOrg: "Sam's lab",
  peerOrigin: "https://hermes.example.com",
};
const OUTSIDE = "con_outside";

let f: Fixture;
let desk: ReturnType<typeof createDeskService>;

beforeEach(async () => {
  f = await createFixture();
  desk = createDeskService({
    a2a: { connections: f.connections, tasks: f.tasks },
    clock: f.clock,
    db: f.db,
    inbox: { listThreads: () => Promise.resolve([]) },
    requests: { listPending: () => Promise.resolve([]) },
    routines: { list: () => Promise.resolve([]) },
    skillsStore: { proposals: () => Promise.resolve([]) },
    triggers: { list: () => Promise.resolve([]) },
  });
});

const needsYou = async () =>
  (await desk.railSources(member(), { dayStart: DAY_START })).needsYou;

/** Connects Hermes with the default policy, and sends it a message that waits. */
const waitingFromHermes = async (text = LONG_TEXT) => {
  await f.connect(HERMES);
  return f.tasks.sendMessage(peerOf(), textMessage("m1", text));
};

test("a message waiting for approval is one Needs you card with its full text", async () => {
  const task = await waitingFromHermes();
  expect(await needsYou()).toMatchObject([
    {
      a2a: {
        checkCode: null,
        connectionId: CONNECTION,
        host: "hermes.example.com",
        org: "Sam's lab",
        peer: "Hermes on Sam's box",
        text: LONG_TEXT,
      },
      agentId: AGENT,
      id: task.id,
      needsYouKind: "a2a_message",
    },
  ]);
});

test("approving a waiting message drops its card", async () => {
  const task = await waitingFromHermes();
  expect(await needsYou()).toHaveLength(1);
  await f.tasks.approveTask(member(), task.id);
  expect(await needsYou()).toEqual([]);
});

test("declining a waiting message drops its card", async () => {
  const task = await waitingFromHermes();
  expect(await needsYou()).toHaveLength(1);
  await f.tasks.declineTask(member(), task.id);
  expect(await needsYou()).toEqual([]);
});

test("the peer cancelling a waiting message drops its card", async () => {
  const task = await waitingFromHermes();
  expect(await needsYou()).toHaveLength(1);
  await f.tasks.cancelTask(peerOf(), { id: task.id });
  expect(await needsYou()).toEqual([]);
});

test("revoking the connection of a waiting message drops its card", async () => {
  await waitingFromHermes();
  expect(await needsYou()).toHaveLength(1);
  await f.connections.revoke(member(), CONNECTION);
  expect(await needsYou()).toEqual([]);
});

test("needsYouCount counts a waiting message and drops it with the card", async () => {
  const task = await waitingFromHermes();
  expect(await desk.needsYouCount(member())).toBe(1);
  await f.tasks.approveTask(member(), task.id);
  expect(await desk.needsYouCount(member())).toBe(0);
});

test("a message from an outside client with no origin has a null host", async () => {
  await f.connect({ id: OUTSIDE });
  const task = await f.tasks.sendMessage(
    peerOf(OUTSIDE),
    textMessage("m1", "Hi")
  );
  expect(await needsYou()).toMatchObject([
    { a2a: { connectionId: OUTSIDE, host: null }, id: task.id },
  ]);
});

test("a connection waiting for approval is an a2a_connection card, and other connections are not listed", async () => {
  await f.connect({
    checkCode: "ABCD2345",
    id: "con_pending",
    peerKind: "harbourmaster",
    peerLabel: "Agent Y",
    peerOrg: "Bob Org",
    peerOrigin: "https://other.example.com",
    status: "needs_approval",
  });
  await f.connect({
    id: "con_revoked",
    revokedAt: START,
    revokedBy: "u-owner",
    status: "revoked",
  });
  await f.connect();
  expect(await needsYou()).toMatchObject([
    {
      a2a: {
        checkCode: "ABCD2345",
        connectionId: "con_pending",
        host: "other.example.com",
        org: "Bob Org",
        peer: "Agent Y",
        text: null,
      },
      id: "con_pending",
      needsYouKind: "a2a_connection",
    },
  ]);
});

/** An outside agent's card whose one interface sits at `url`, as `connections.test.ts` builds it. */
const outsideCard = (url: string) => ({
  capabilities: {},
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  description: "An outside agent",
  name: "Outside",
  provider: { organization: "Acme", url: "https://acme.example" },
  securityRequirements: [{ schemes: { bearer: { list: [] } } }],
  securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "bearer" } } },
  skills: [
    { description: "Does things", id: "do", name: "Do", tags: ["misc"] },
  ],
  supportedInterfaces: [
    { protocolBinding: "JSONRPC", protocolVersion: "1.0", url },
  ],
  version: "1",
});

test("an outside agent whose card moved to another origin is a Needs you card with the new host", async () => {
  let rpcUrl = "https://agent.example.com/rpc";
  const connections = createConnectionsService({
    atomic: sqliteAtomic(f.db),
    clock: f.clock,
    db: f.db,
    events: f.events,
    fetchCard: () => Promise.resolve(outsideCard(rpcUrl)),
    publicBaseUrl: "https://hm.test",
    secretsKey: SECRETS_KEY,
  });
  desk = createDeskService({
    a2a: { connections, tasks: f.tasks },
    clock: f.clock,
    db: f.db,
    inbox: { listThreads: () => Promise.resolve([]) },
    requests: { listPending: () => Promise.resolve([]) },
    routines: { list: () => Promise.resolve([]) },
    skillsStore: { proposals: () => Promise.resolve([]) },
    triggers: { list: () => Promise.resolve([]) },
  });
  const owner = member("u-owner");
  const connection = await connections.addOutbound(owner, {
    agentId: AGENT,
    cardUrl: "https://agent.example.com/.well-known/agent-card.json",
    credential: "sk-outside-agent-credential-12345",
  });
  expect(await needsYou()).toEqual([]);

  rpcUrl = "https://elsewhere.example.org/rpc";
  await connections.refreshCard(owner, connection.id);
  expect(await needsYou()).toMatchObject([
    {
      a2a: { connectionId: connection.id, host: "elsewhere.example.org" },
      id: connection.id,
      needsYouKind: "a2a_connection",
    },
  ]);
});

test("a message for an agent that is a draft is not listed", async () => {
  await waitingFromHermes();
  expect(await needsYou()).toHaveLength(1);
  await f.db
    .update(agents)
    .set({ status: "draft" })
    .where(eq(agents.id, AGENT));
  expect(await needsYou()).toEqual([]);
});

test("a peer cannot read railSources", async () => {
  await waitingFromHermes();
  await expect(
    desk.railSources(peerOf(), { dayStart: DAY_START })
  ).rejects.toBeInstanceOf(ForbiddenError);
});
