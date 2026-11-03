import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { a2aAgentCards, a2aConnections, a2aOutbox } from "@repo/db/schema/a2a";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { and, eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "../agents.ts";
import { can, ForbiddenError } from "../authz.ts";
import { decryptSecret, importSecretsKey } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import { createEventsService, type EventsService } from "../events.ts";
import { deriveSubject, eventActor } from "../runs/subject.ts";
import type { Clock } from "../runs/types.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import {
  type ConnectionsService,
  createConnectionsService,
  INVITE_MAX_FAILURES,
  INVITE_TTL_MS,
  type PairingTransport,
  REFRESH_BATCH,
} from "./connections.ts";
import { MANAGED_REFUSAL } from "./errors.ts";

const BASE = "https://hm.test";
const START = "2026-11-01T10:00:00.000Z";
const CREATED = "2026-10-01T00:00:00.000Z";
const SECRETS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const W_ALICE = "w-alice";
const W_BOB = "w-bob";
const AGENT_X = "a-x";
const AGENT_X2 = "a-x2";
const AGENT_Y = "a-y";
const INSTRUCTIONS = "TOP-SECRET-INSTRUCTIONS-DO-NOT-LEAK";
const OUTSIDE_CARD_URL =
  "https://agent.example.com/.well-known/agent-card.json";
const OUTSIDE_SECRET = "sk-outside-agent-credential-12345";
const OAUTH_SECRET = "oauth-client-secret-67890";
const CHECK_CODE = /^[A-HJ-NP-Z2-9]{8}$/;

const session = (
  userId: string,
  workspaceId: string,
  isAdmin = false
): Principal => ({
  isAdmin,
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});

/** Admin of Alice's org, the owner of X, a plain member of her org, and Bob (owner of Y). */
const adminA = session("u-admin", W_ALICE, true);
const ownerA = session("u-owner", W_ALICE);
const memberA = session("u-member", W_ALICE);
const ownerB = session("u-bob", W_BOB);

const SKILLS = [
  {
    description: "Answers questions about the deployment.",
    id: "ask",
    name: "Ask",
    tags: ["support"],
  },
];

const outsideCard = (overrides: Record<string, unknown> = {}) => ({
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
    {
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
      url: "https://agent.example.com/rpc",
    },
  ],
  version: "1",
  ...overrides,
});

type Db = ReturnType<typeof migrated>;

let db: Db;
let nowMs: number;
let clock: Clock;
let events: EventsService;
let agents: AgentsService;
let service: ConnectionsService;
let peerCard: unknown;
let activateFails: boolean;
let joinBodies: { token: string; cardUrl: string }[];
let activations: { bearer: string; token: string; url: string }[];

const transport: PairingTransport = {
  activate: async ({ bearer, token, url }) => {
    activations.push({ bearer, token, url });
    if (activateFails) {
      throw new Error("peer unreachable");
    }
    await service.activate(bearer, { token });
  },
  join: async ({ body, inviteToken }) => {
    joinBodies.push({ cardUrl: body.cardUrl, token: body.token });
    return await service.join(inviteToken, body);
  },
};

const seedWorkspace = (id: string, name: string) =>
  db
    .insert(workspaceRows)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: CREATED,
      id,
      name,
      timezone: "UTC",
    })
    .run();

const seedAgent = (
  id: string,
  workspaceId: string,
  createdBy: string,
  name: string
) =>
  db
    .insert(agentRows)
    .values({
      createdAt: CREATED,
      createdBy,
      id,
      instructions: INSTRUCTIONS,
      model: "m",
      name,
      runtime: "fake",
      runtimeConfig: "{}",
      slug: id,
      status: "active",
      workspaceId,
    })
    .run();

beforeEach(() => {
  db = migrated();
  nowMs = Date.parse(START);
  clock = { now: () => new Date(nowMs), sleep: () => Promise.resolve() };
  seedWorkspace(W_ALICE, "Alice Org");
  seedWorkspace(W_BOB, "Bob Org");
  seedAgent(AGENT_X, W_ALICE, "u-owner", "Agent X");
  seedAgent(AGENT_X2, W_ALICE, "u-owner", "Agent X2");
  seedAgent(AGENT_Y, W_BOB, "u-bob", "Agent Y");
  const store = new Map<string, string>();
  events = createEventsService({
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    db,
  });
  agents = createAgentsService({ db, events });
  peerCard = outsideCard();
  activateFails = false;
  joinBodies = [];
  activations = [];
  service = createConnectionsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    fetchCard: () => Promise.resolve(peerCard),
    publicBaseUrl: BASE,
    secretsKey: SECRETS_KEY,
    transport,
  });
});

/** A second service on the same database, with its own card fetch. */
const serviceFetching = (fetchCard: (url: string) => Promise<unknown>) =>
  createConnectionsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    fetchCard,
    publicBaseUrl: BASE,
    secretsKey: SECRETS_KEY,
  });

const publishBoth = async () => {
  await service.publish(ownerA, {
    agentId: AGENT_X,
    description: "Agent X answers questions.",
    skills: SKILLS,
  });
  await service.publish(ownerB, {
    agentId: AGENT_Y,
    description: "Agent Y answers questions.",
    skills: SKILLS,
  });
};

/** Alice invites with X, Bob joins with Y. Alice waits for approval. */
const toNeedsApproval = async () => {
  await publishBoth();
  const invite = await service.createInvite(ownerA, { agentId: AGENT_X });
  const joined = await service.joinWithLink(ownerB, {
    agentId: AGENT_Y,
    link: invite.link,
  });
  const bobToken = joinBodies.at(-1)?.token ?? "";
  return {
    aliceId: invite.connection.id,
    bobId: joined.connection.id,
    bobToken,
    checkCode: joined.checkCode,
    inviteLink: invite.link,
  };
};

/** A full pairing. Returns both ids and both tokens. */
const pairFully = async () => {
  const pending = await toNeedsApproval();
  await approveAs(ownerA, pending.aliceId);
  const aliceToken = activations.at(-1)?.token ?? "";
  return { ...pending, aliceToken };
};

/** What the page would send back: the destination it showed for the connection. */
const seenOf = async (id: string) => {
  const connection = await service.get(adminA, id);
  return {
    origin: connection.pendingOrigin ?? connection.peerOrigin ?? "",
    tokenUrl: connection.pendingTokenUrl ?? connection.tokenUrl,
  };
};

const approveAs = async (principal: Principal, id: string) =>
  await service.approve(principal, id, await seenOf(id));

const publishedFor = async (principal: Principal, agentId: string) => {
  const card = await service.getPublished(principal, agentId);
  if (!card) {
    throw new Error("The agent is not published");
  }
  return card;
};

const rowOf = (id: string) =>
  db.select().from(a2aConnections).where(eq(a2aConnections.id, id)).get();

describe("publishing", () => {
  test("a published card carries the reviewed text and never the instructions", async () => {
    await publishBoth();
    const published = await publishedFor(ownerA, AGENT_X);
    const card = await service.publicCard(published.publicId);
    expect(card?.agentName).toBe("Agent X");
    expect(card?.description).toBe("Agent X answers questions.");
    expect(JSON.stringify(card)).not.toContain(INSTRUCTIONS);
    expect(JSON.stringify(published)).not.toContain(INSTRUCTIONS);
    expect(published.cardUrl).toBe(
      `${BASE}/a2a/${published.publicId}/.well-known/agent-card.json`
    );
  });

  test("unpublishing removes the card and kills the tokens, and republishing keeps the public id", async () => {
    await publishBoth();
    const first = await publishedFor(ownerA, AGENT_X);
    const key = await service.createAccessKey(ownerA, {
      agentId: AGENT_X,
      label: "Hermes",
    });
    expect(await service.authenticate(key.token)).not.toBeNull();
    await service.unpublish(ownerA, AGENT_X);
    expect(await service.publicCard(first.publicId)).toBeNull();
    expect(await service.authenticate(key.token)).toBeNull();
    await service.publish(ownerA, {
      agentId: AGENT_X,
      description: "Back again.",
      skills: SKILLS,
    });
    const again = await publishedFor(ownerA, AGENT_X);
    expect(again.publicId).toBe(first.publicId);
    expect(await service.authenticate(key.token)).not.toBeNull();
  });

  test("a non-owner member may not publish, an admin may", async () => {
    await expect(
      service.publish(memberA, {
        agentId: AGENT_X,
        description: "d",
        skills: SKILLS,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await service.publish(adminA, {
      agentId: AGENT_X,
      description: "d",
      skills: SKILLS,
    });
  });

  test("an agent on the managed runtime is refused and nothing is written", async () => {
    db.update(agentRows)
      .set({ runtime: "managed" })
      .where(eq(agentRows.id, AGENT_X))
      .run();
    await expect(
      service.publish(ownerA, {
        agentId: AGENT_X,
        description: "d",
        skills: SKILLS,
      })
    ).rejects.toMatchObject({ code: "invalid" });
    expect(
      await db
        .select()
        .from(a2aAgentCards)
        .where(eq(a2aAgentCards.agentId, AGENT_X))
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(eventRows)
        .where(eq(eventRows.type, "a2a.agent_published"))
    ).toHaveLength(0);
  });

  test("cloud and machine agents still publish", async () => {
    db.update(agentRows)
      .set({ runtime: "cloud" })
      .where(eq(agentRows.id, AGENT_X))
      .run();
    db.update(agentRows)
      .set({ runtime: "machine" })
      .where(eq(agentRows.id, AGENT_Y))
      .run();
    await publishBoth();
    expect((await publishedFor(ownerA, AGENT_X)).agentId).toBe(AGENT_X);
    expect((await publishedFor(ownerB, AGENT_Y)).agentId).toBe(AGENT_Y);
  });
});

describe("pairing", () => {
  test("a full pairing on two workspaces ends with both rows active and both tokens working", async () => {
    const paired = await pairFully();
    expect(rowOf(paired.aliceId)?.status).toBe("active");
    expect(rowOf(paired.bobId)?.status).toBe("active");
    const alice = await service.authenticate(paired.aliceToken);
    expect(alice).toEqual({
      agentId: AGENT_X,
      connectionId: paired.aliceId,
      kind: "peer",
      workspaceId: W_ALICE,
    });
    const bob = await service.authenticate(paired.bobToken);
    expect(bob).toEqual({
      agentId: AGENT_Y,
      connectionId: paired.bobId,
      kind: "peer",
      workspaceId: W_BOB,
    });
    expect(rowOf(paired.aliceId)?.outboundCredential).toStartWith("v1:");
    expect(rowOf(paired.bobId)?.outboundCredential).toStartWith("v1:");
    expect(
      await db
        .select()
        .from(a2aOutbox)
        .where(eq(a2aOutbox.kind, "pair_activate"))
    ).toHaveLength(0);
  });

  test("both sides show the same check code and the organisation comes from our own row", async () => {
    const pending = await toNeedsApproval();
    const alice = await service.get(ownerA, pending.aliceId);
    const bob = await service.get(ownerB, pending.bobId);
    expect(alice.checkCode).toBe(pending.checkCode);
    expect(bob.checkCode).toBe(pending.checkCode);
    expect(pending.checkCode).toMatch(CHECK_CODE);
    expect(alice.peerOrg).toBe("Bob Org");
    expect(bob.peerOrg).toBe("Alice Org");
    expect(alice.status).toBe("needs_approval");
    expect(bob.status).toBe("awaiting_peer");
  });

  test("the claimed organisation is ignored on the same deployment", async () => {
    await publishBoth();
    const invite = await service.createInvite(ownerA, { agentId: AGENT_X });
    const published = await publishedFor(ownerB, AGENT_Y);
    await service.join(invite.link.split("/connect/")[1] ?? "", {
      agentName: "Agent Y",
      cardUrl: published.cardUrl,
      orgName: "Totally Trusted Bank",
      token: "hm_a2a_".padEnd(48, "x"),
    });
    const alice = await service.get(ownerA, invite.connection.id);
    expect(alice.peerOrg).toBe("Bob Org");
  });

  test("an invite is refused within one workspace", async () => {
    await publishBoth();
    await service.publish(ownerA, {
      agentId: AGENT_X2,
      description: "Second.",
      skills: SKILLS,
    });
    const invite = await service.createInvite(ownerA, { agentId: AGENT_X });
    await expect(
      service.joinWithLink(ownerA, { agentId: AGENT_X2, link: invite.link })
    ).rejects.toBeInstanceOf(ServiceError);
    const row = rowOf(invite.connection.id);
    expect(row?.status).toBe("inviting");
    const all = await service.list(ownerA);
    expect(all.filter((c) => c.agentId === AGENT_X2)).toHaveLength(0);
  });

  test("a second live connection between the same agent and the same peer card is refused", async () => {
    await pairFully();
    const again = await service.createInvite(ownerA, { agentId: AGENT_X });
    await expect(
      service.joinWithLink(ownerB, { agentId: AGENT_Y, link: again.link })
    ).rejects.toBeInstanceOf(ServiceError);
    expect(rowOf(again.connection.id)?.status).toBe("inviting");
  });

  test("an expired invite is refused", async () => {
    await publishBoth();
    const invite = await service.createInvite(ownerA, { agentId: AGENT_X });
    nowMs += INVITE_TTL_MS + 1;
    await expect(
      service.joinWithLink(ownerB, { agentId: AGENT_Y, link: invite.link })
    ).rejects.toBeInstanceOf(ServiceError);
    expect(rowOf(invite.connection.id)?.status).toBe("inviting");
    expect(await service.list(ownerB)).toHaveLength(0);
  });

  test("a used invite cannot be used again", async () => {
    const pending = await toNeedsApproval();
    const token = pending.inviteLink.split("/connect/")[1] ?? "";
    await expect(
      service.join(token, {
        agentName: "Agent Y",
        cardUrl: joinBodies[0]?.cardUrl ?? "",
        token: "hm_a2a_".padEnd(48, "y"),
      })
    ).rejects.toBeInstanceOf(ServiceError);
  });

  test("two joins at once cannot both win", async () => {
    await publishBoth();
    const invite = await service.createInvite(ownerA, { agentId: AGENT_X });
    const token = invite.link.split("/connect/")[1] ?? "";
    const published = await publishedFor(ownerB, AGENT_Y);
    const attempt = (secret: string) =>
      service.join(token, {
        agentName: "Agent Y",
        cardUrl: published.cardUrl,
        token: `hm_a2a_${secret}`.padEnd(48, "z"),
      });
    const results = await Promise.allSettled([attempt("one"), attempt("two")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rowOf(invite.connection.id)?.status).toBe("needs_approval");
  });

  test("the fifth bad try ends the invite and the sixth is refused even with the right secret", async () => {
    await publishBoth();
    const invite = await service.createInvite(ownerA, { agentId: AGENT_X });
    const token = invite.link.split("/connect/")[1] ?? "";
    const wrong = `${token.split(".")[0]}.wrongsecret`;
    for (let i = 0; i < INVITE_MAX_FAILURES; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the tries must run in order
      await expect(
        service.join(wrong, {
          agentName: "Agent Y",
          cardUrl: `${BASE}/a2a/none/.well-known/agent-card.json`,
          token: "hm_a2a_".padEnd(48, "w"),
        })
      ).rejects.toBeInstanceOf(ServiceError);
    }
    expect(rowOf(invite.connection.id)?.inviteFailures).toBe(
      INVITE_MAX_FAILURES
    );
    await expect(
      service.joinWithLink(ownerB, { agentId: AGENT_Y, link: invite.link })
    ).rejects.toBeInstanceOf(ServiceError);
    expect(rowOf(invite.connection.id)?.status).toBe("revoked");
  });

  test("four bad tries leave the invite working", async () => {
    await publishBoth();
    const invite = await service.createInvite(ownerA, { agentId: AGENT_X });
    const token = invite.link.split("/connect/")[1] ?? "";
    const wrong = `${token.split(".")[0]}.wrongsecret`;
    for (let i = 0; i < INVITE_MAX_FAILURES - 1; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the tries must run in order
      await expect(
        service.join(wrong, {
          agentName: "Agent Y",
          cardUrl: `${BASE}/a2a/none/.well-known/agent-card.json`,
          token: "hm_a2a_".padEnd(48, "w"),
        })
      ).rejects.toBeInstanceOf(ServiceError);
    }
    await service.joinWithLink(ownerB, {
      agentId: AGENT_Y,
      link: invite.link,
    });
    expect(rowOf(invite.connection.id)?.status).toBe("needs_approval");
  });

  test("a decline leaves no usable token on either side", async () => {
    const pending = await toNeedsApproval();
    await service.decline(ownerA, pending.aliceId);
    const outbox = await db
      .select()
      .from(a2aOutbox)
      .where(eq(a2aOutbox.kind, "pair_decline"));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.url).toEndWith("/pair/decline");
    // The outbox delivers the notice with the credential Bob issued as bearer.
    await service.declined(pending.bobToken);
    const alice = rowOf(pending.aliceId);
    const bob = rowOf(pending.bobId);
    expect(alice?.status).toBe("declined");
    expect(alice?.outboundCredential).toBeNull();
    expect(alice?.inboundTokenHash).toBeNull();
    expect(bob?.status).toBe("declined");
    expect(bob?.inboundTokenHash).toBeNull();
    expect(await service.authenticate(pending.bobToken)).toBeNull();
  });

  test("an activation that cannot be delivered leaves the row activating and the outbox holds it sealed", async () => {
    activateFails = true;
    const pending = await toNeedsApproval();
    const approved = await approveAs(ownerA, pending.aliceId);
    expect(approved.status).toBe("activating");
    const [queued] = await db
      .select()
      .from(a2aOutbox)
      .where(eq(a2aOutbox.kind, "pair_activate"));
    expect(queued?.url).toEndWith("/pair/activate");
    // What AA.5 does: unseal the headers and the token, deliver, then confirm.
    const key = await importSecretsKey(SECRETS_KEY);
    const binding = (field: string) => ({
      field,
      rowId: queued?.id ?? "",
      table: "a2a_outbox",
      workspaceId: W_ALICE,
    });
    const headers = JSON.parse(
      await decryptSecret(key, binding("headers"), queued?.headers ?? "")
    ) as { Authorization: string };
    const body = JSON.parse(queued?.body ?? "{}") as { token: string };
    const token = await decryptSecret(key, binding("body.token"), body.token);
    await service.activate(headers.Authorization.replace("Bearer ", ""), {
      token,
    });
    await service.activationDelivered(SYSTEM_PRINCIPAL, pending.aliceId);
    expect(rowOf(pending.aliceId)?.status).toBe("active");
    expect(rowOf(pending.bobId)?.status).toBe("active");
    expect(await service.authenticate(token)).not.toBeNull();
    expect(await db.select().from(a2aOutbox)).toHaveLength(0);
  });

  test("a revoke while the activation waits stops it from being delivered", async () => {
    activateFails = true;
    const pending = await toNeedsApproval();
    await approveAs(ownerA, pending.aliceId);
    await service.revoke(memberA, pending.aliceId);
    expect(
      await db
        .select()
        .from(a2aOutbox)
        .where(eq(a2aOutbox.kind, "pair_activate"))
    ).toHaveLength(0);
  });
});

describe("access keys and outside agents", () => {
  test("an access key is shown once and stored as a hash", async () => {
    await publishBoth();
    const key = await service.createAccessKey(ownerA, {
      agentId: AGENT_X,
      label: "Hermes on Sam's box",
    });
    expect(key.token).toStartWith("hm_a2a_");
    expect(key.connection.peerKind).toBe("a2a_inbound");
    expect(key.connection.status).toBe("active");
    expect(key.connection.tokenPrefix).toBe(key.token.slice(0, 11));
    expect(key.cardUrl).toContain("/a2a/");
    const principal = await service.authenticate(key.token);
    expect(principal?.connectionId).toBe(key.connection.id);
    expect(JSON.stringify(await service.list(ownerA))).not.toContain(key.token);
  });

  test("authenticate refuses anything but an active connection's token", async () => {
    await publishBoth();
    expect(await service.authenticate("hm_a2a_unknown")).toBeNull();
    expect(await service.authenticate("hm_trg_whatever")).toBeNull();
    expect(await service.authenticate("")).toBeNull();
    const pending = await toNeedsApproval();
    // Bob's token exists but his row waits for Alice.
    expect(await service.authenticate(pending.bobToken)).toBeNull();
  });

  test("authenticate with a public id accepts only that agent's path", async () => {
    await publishBoth();
    const key = await service.createAccessKey(ownerA, {
      agentId: AGENT_X,
      label: "Hermes",
    });
    const own = await publishedFor(ownerA, AGENT_X);
    const other = await publishedFor(ownerB, AGENT_Y);
    expect(
      (await service.authenticate(key.token, own.publicId))?.connectionId
    ).toBe(key.connection.id);
    expect(await service.authenticate(key.token, other.publicId)).toBeNull();
    expect(await service.authenticate(key.token, "pub_unknown")).toBeNull();
  });

  test("the pairing calls with a public id accept only the path of the connection's agent", async () => {
    const pending = await toNeedsApproval();
    const bobs = await publishedFor(ownerB, AGENT_Y);
    const alices = await publishedFor(ownerA, AGENT_X);
    await expect(
      service.declined(pending.bobToken, alices.publicId)
    ).rejects.toMatchObject({ code: "not_found" });
    expect(rowOf(pending.bobId)?.status).toBe("awaiting_peer");
    await service.declined(pending.bobToken, bobs.publicId);
    expect(rowOf(pending.bobId)?.status).toBe("declined");
  });

  test("a revoked token fails on the next authenticate with no other step", async () => {
    await publishBoth();
    const key = await service.createAccessKey(ownerA, {
      agentId: AGENT_X,
      label: "Hermes",
    });
    expect(await service.authenticate(key.token)).not.toBeNull();
    await service.revoke(memberA, key.connection.id);
    expect(await service.authenticate(key.token)).toBeNull();
    const row = rowOf(key.connection.id);
    expect(row?.status).toBe("revoked");
    expect(row?.revokedBy).toBe("u-member");
  });

  test("an outside agent is added with its credential sealed and its origin kept", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    expect(connection.status).toBe("active");
    expect(connection.peerKind).toBe("a2a_outbound");
    expect(connection.peerOrigin).toBe("https://agent.example.com");
    expect(connection.peerOrg).toBe("Acme");
    const row = rowOf(connection.id);
    expect(row?.outboundScheme).toBe("bearer");
    expect(row?.outboundCredential).toStartWith("v1:");
    expect(row?.outboundCredential).not.toContain(OUTSIDE_SECRET);
    const key = await importSecretsKey(SECRETS_KEY);
    expect(
      await decryptSecret(
        key,
        {
          field: "outbound_credential",
          rowId: connection.id,
          table: "a2a_connections",
          workspaceId: W_ALICE,
        },
        row?.outboundCredential ?? ""
      )
    ).toBe(OUTSIDE_SECRET);
  });

  test("an outside agent is added only for the destination the preview showed", async () => {
    const preview = await service.previewCard(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
    });
    await expect(
      service.addOutbound(ownerA, {
        agentId: AGENT_X,
        cardUrl: OUTSIDE_CARD_URL,
        credential: OUTSIDE_SECRET,
        seen: { origin: "https://elsewhere.example.com", tokenUrl: null },
      })
    ).rejects.toThrow("destination changed");
    expect(await db.select().from(a2aConnections)).toHaveLength(0);
    const added = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
      seen: { origin: preview.origin, tokenUrl: preview.tokenUrl },
    });
    expect(added.status).toBe("active");
  });

  test("a scheme the design does not list is refused and names what the card wanted", async () => {
    peerCard = outsideCard({
      securityRequirements: [{ schemes: { oidc: { list: [] } } }],
      securitySchemes: {
        oidc: {
          openIdConnectSecurityScheme: {
            openIdConnectUrl: "https://idp.example.com/.well-known/openid",
          },
        },
      },
    });
    await expect(
      service.addOutbound(ownerA, {
        agentId: AGENT_X,
        cardUrl: OUTSIDE_CARD_URL,
        credential: "x",
      })
    ).rejects.toThrow("OpenID Connect");
    expect(await db.select().from(a2aConnections)).toHaveLength(0);
  });

  test("previewCard shows the card and what it asks for, and creates nothing", async () => {
    const preview = await service.previewCard(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
    });
    expect(preview).toEqual({
      description: "An outside agent",
      host: "agent.example.com",
      name: "Outside",
      org: "Acme",
      origin: "https://agent.example.com",
      scheme: "bearer",
      skills: [{ description: "Does things", name: "Do" }],
      tokenUrl: null,
    });
    expect(await db.select().from(a2aConnections)).toHaveLength(0);
  });

  test("previewCard refuses what addOutbound refuses, and a member who may not connect", async () => {
    await expect(
      service.previewCard(memberA, {
        agentId: AGENT_X,
        cardUrl: OUTSIDE_CARD_URL,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.previewCard(ownerA, {
        agentId: AGENT_X,
        cardUrl: "https://10.0.0.5/.well-known/agent-card.json",
      })
    ).rejects.toBeInstanceOf(ServiceError);
    peerCard = outsideCard({
      securityRequirements: [{ schemes: { oidc: { list: [] } } }],
      securitySchemes: {
        oidc: {
          openIdConnectSecurityScheme: {
            openIdConnectUrl: "https://idp.example.com/.well-known/openid",
          },
        },
      },
    });
    await expect(
      service.previewCard(ownerA, {
        agentId: AGENT_X,
        cardUrl: OUTSIDE_CARD_URL,
      })
    ).rejects.toThrow("OpenID Connect");
  });

  test("a card URL on a private address is refused before anything is fetched", async () => {
    let fetched = false;
    const guarded = createConnectionsService({
      atomic: sqliteAtomic(db),
      clock,
      db,
      events,
      fetchCard: () => {
        fetched = true;
        return Promise.resolve(peerCard);
      },
      publicBaseUrl: BASE,
      secretsKey: SECRETS_KEY,
    });
    await expect(
      guarded.addOutbound(ownerA, {
        agentId: AGENT_X,
        cardUrl: "https://10.0.0.5/.well-known/agent-card.json",
        credential: "x",
      })
    ).rejects.toBeInstanceOf(ServiceError);
    expect(fetched).toBe(false);
  });

  test("an agent on the managed runtime is refused, nothing is fetched, and nothing is written", async () => {
    let fetched = false;
    const guarded = createConnectionsService({
      atomic: sqliteAtomic(db),
      clock,
      db,
      events,
      fetchCard: () => {
        fetched = true;
        return Promise.resolve(peerCard);
      },
      publicBaseUrl: BASE,
      secretsKey: SECRETS_KEY,
    });
    db.update(agentRows)
      .set({ runtime: "managed" })
      .where(eq(agentRows.id, AGENT_X))
      .run();
    await expect(
      guarded.addOutbound(ownerA, {
        agentId: AGENT_X,
        cardUrl: OUTSIDE_CARD_URL,
        credential: OUTSIDE_SECRET,
      })
    ).rejects.toThrow(MANAGED_REFUSAL);
    expect(fetched).toBe(false);
    expect(await db.select().from(a2aConnections)).toHaveLength(0);
  });

  test("the origin change returns a connection to needs_approval", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    // The same card keeps it active.
    expect((await service.refreshCard(ownerA, connection.id)).status).toBe(
      "active"
    );
    peerCard = outsideCard({
      supportedInterfaces: [
        {
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
          url: "https://elsewhere.example.org/rpc",
        },
      ],
    });
    const refreshed = await service.refreshCard(
      SYSTEM_PRINCIPAL,
      connection.id
    );
    expect(refreshed.status).toBe("needs_approval");
    // The approved origin does not move until a person approves.
    expect(refreshed.peerOrigin).toBe("https://agent.example.com");
    const logged = await db
      .select()
      .from(eventRows)
      .where(eq(eventRows.type, "a2a.connection_reapproval_needed"));
    expect(logged).toHaveLength(1);
    const approved = await approveAs(ownerA, connection.id);
    expect(approved.status).toBe("active");
    expect(approved.peerOrigin).toBe("https://elsewhere.example.org");
  });
});

describe("the daily card refresh", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const moveTo = (rpcUrl: string) =>
    outsideCard({
      supportedInterfaces: [
        { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: rpcUrl },
      ],
    });
  const reapprovalEvents = () =>
    db
      .select()
      .from(eventRows)
      .where(eq(eventRows.type, "a2a.connection_reapproval_needed"))
      .all();

  test("refreshDue refuses a person and a peer", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    nowMs += DAY;
    const peer: Principal = {
      agentId: AGENT_X,
      connectionId: connection.id,
      kind: "peer",
      workspaceId: W_ALICE,
    };
    await expect(service.refreshDue(ownerA)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(service.refreshDue(peer)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(rowOf(connection.id)?.peerCardFetchedAt).toBe(START);
  });

  test("a card that moved is flagged once a day later, and nothing else is sent", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    const outboxBefore = await db.select().from(a2aOutbox);
    const fetches: string[] = [];
    const ticking = serviceFetching((url) => {
      fetches.push(url);
      return Promise.resolve(moveTo("https://elsewhere.example.org/rpc"));
    });
    nowMs += DAY;
    expect(await ticking.refreshDue(SYSTEM_PRINCIPAL)).toBe(1);
    expect(rowOf(connection.id)?.status).toBe("needs_approval");
    expect(reapprovalEvents()).toHaveLength(1);
    expect(fetches).toEqual([OUTSIDE_CARD_URL]);
    expect(await db.select().from(a2aOutbox)).toHaveLength(outboxBefore.length);
    expect(activations).toHaveLength(0);
  });

  test("an unchanged card stays active and gets a new fetch time", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    nowMs += DAY;
    expect(await service.refreshDue(SYSTEM_PRINCIPAL)).toBe(1);
    const row = rowOf(connection.id);
    expect(row?.status).toBe("active");
    expect(row?.peerCardFetchedAt).toBe(new Date(nowMs).toISOString());
    expect(reapprovalEvents()).toHaveLength(0);
  });

  test("a connection fetched less than a day ago is left alone", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    peerCard = moveTo("https://elsewhere.example.org/rpc");
    const fetches: string[] = [];
    const ticking = serviceFetching((url) => {
      fetches.push(url);
      return Promise.resolve(peerCard);
    });
    nowMs += DAY - 1;
    expect(await ticking.refreshDue(SYSTEM_PRINCIPAL)).toBe(0);
    expect(fetches).toHaveLength(0);
    expect(rowOf(connection.id)?.status).toBe("active");
    expect(rowOf(connection.id)?.peerCardFetchedAt).toBe(START);
  });

  test("a card that fails to fetch leaves its row as it was, and the next peer is refreshed", async () => {
    const broken = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: "https://broken.example.com/agent-card.json",
      credential: OUTSIDE_SECRET,
    });
    const healthy = await service.addOutbound(ownerA, {
      agentId: AGENT_X2,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    const before = rowOf(broken.id);
    nowMs += DAY;
    const ticking = serviceFetching((url) =>
      url.includes("broken")
        ? Promise.reject(new Error("peer unreachable"))
        : Promise.resolve(moveTo("https://elsewhere.example.org/rpc"))
    );
    expect(await ticking.refreshDue(SYSTEM_PRINCIPAL)).toBe(1);
    const after = rowOf(broken.id);
    expect(after?.status).toBe(before?.status);
    expect(after?.peerCard).toBe(before?.peerCard ?? null);
    expect(after?.peerCardFetchedAt).toBe(START);
    expect(rowOf(healthy.id)?.status).toBe("needs_approval");
  });

  test("a card that fails is not fetched again for an hour, and dead peers do not crowd out the others", async () => {
    const dead: string[] = [];
    for (let i = 0; i < REFRESH_BATCH; i += 1) {
      nowMs = Date.parse(START) + i * 1000;
      // biome-ignore lint/performance/noAwaitInLoops: each add stamps its own fetch time
      const connection = await service.addOutbound(ownerA, {
        agentId: AGENT_X,
        cardUrl: `https://dead.example.com/cards/${i}.json`,
        credential: OUTSIDE_SECRET,
      });
      dead.push(connection.id);
    }
    nowMs = Date.parse(START) + (REFRESH_BATCH + 1) * 1000;
    const healthy = await service.addOutbound(ownerA, {
      agentId: AGENT_X2,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    const fetches: string[] = [];
    const ticking = serviceFetching((url) => {
      fetches.push(url);
      return url.includes("dead")
        ? Promise.reject(new Error("peer unreachable"))
        : Promise.resolve(moveTo("https://elsewhere.example.org/rpc"));
    });
    nowMs = Date.parse(START) + DAY + 60 * 1000;
    expect(await ticking.refreshDue(SYSTEM_PRINCIPAL)).toBe(0);
    expect(fetches).toHaveLength(REFRESH_BATCH);
    expect(rowOf(healthy.id)?.status).toBe("active");
    // A minute later the dead peers sit out and the healthy one gets its turn.
    nowMs += 60 * 1000;
    fetches.length = 0;
    expect(await ticking.refreshDue(SYSTEM_PRINCIPAL)).toBe(1);
    expect(fetches).toEqual([OUTSIDE_CARD_URL]);
    expect(rowOf(healthy.id)?.status).toBe("needs_approval");
    for (const id of dead) {
      expect(rowOf(id)?.peerCardFetchedAt).toStartWith("2026-");
      expect(rowOf(id)?.status).toBe("active");
    }
    // An hour after the first try they are tried again.
    nowMs = Date.parse(START) + DAY + 60 * 60 * 1000 + 60 * 1000;
    fetches.length = 0;
    expect(await ticking.refreshDue(SYSTEM_PRINCIPAL)).toBe(0);
    expect(fetches).toHaveLength(REFRESH_BATCH);
  });

  test("the oldest due cards go first and no more than a batch", async () => {
    const ids: string[] = [];
    for (let i = 0; i <= REFRESH_BATCH; i += 1) {
      nowMs = Date.parse(START) + i * 1000;
      // biome-ignore lint/performance/noAwaitInLoops: each add stamps its own fetch time
      const connection = await service.addOutbound(ownerA, {
        agentId: AGENT_X,
        cardUrl: `https://agent.example.com/cards/${i}.json`,
        credential: OUTSIDE_SECRET,
      });
      ids.push(connection.id);
    }
    nowMs = Date.parse(START) + DAY + 60 * 60 * 1000;
    expect(await service.refreshDue(SYSTEM_PRINCIPAL)).toBe(REFRESH_BATCH);
    const refreshedAt = new Date(nowMs).toISOString();
    for (const id of ids.slice(0, REFRESH_BATCH)) {
      expect(rowOf(id)?.peerCardFetchedAt).toBe(refreshedAt);
    }
    expect(rowOf(ids.at(-1) ?? "")?.peerCardFetchedAt).toBe(
      new Date(Date.parse(START) + REFRESH_BATCH * 1000).toISOString()
    );
  });

  test("a due refresh and a person's refresh of a moved card log once", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    nowMs += DAY;
    const quick = serviceFetching(() =>
      Promise.resolve(moveTo("https://first.example.com/rpc"))
    );
    // The person's refresh reads the connection, then the tick refreshes it
    // while the card is fetched.
    const slow = serviceFetching(async () => {
      await quick.refreshDue(SYSTEM_PRINCIPAL);
      return moveTo("https://second.example.net/rpc");
    });
    const refreshed = await slow.refreshCard(ownerA, connection.id);
    expect(refreshed.status).toBe("needs_approval");
    expect(refreshed.pendingOrigin).toBe("https://first.example.com");
    expect(reapprovalEvents()).toHaveLength(1);
  });
});

describe("who may act", () => {
  const refused: [string, Principal][] = [
    [
      "a run principal",
      { agentId: AGENT_X, kind: "run", runId: "r1", workspaceId: W_ALICE },
    ],
    [
      "an API key",
      {
        apiKey: { access: "write", id: "key1" },
        isAdmin: true,
        kind: "user",
        userId: "u-admin",
        via: "api_key",
        workspaceId: W_ALICE,
      },
    ],
    [
      "a read-only OAuth client",
      {
        isAdmin: true,
        kind: "user",
        oauthClient: { access: "read", clientId: "c1" },
        userId: "u-admin",
        via: "oauth",
        workspaceId: W_ALICE,
      },
    ],
    ["a machine", { kind: "machine", machineId: "m1", workspaceId: W_ALICE }],
    [
      "a trigger",
      {
        agentId: AGENT_X,
        kind: "trigger",
        triggerId: "t1",
        workspaceId: W_ALICE,
      },
    ],
    [
      "a peer",
      {
        agentId: AGENT_X,
        connectionId: "con_x",
        kind: "peer",
        workspaceId: W_ALICE,
      },
    ],
  ];

  for (const [name, principal] of refused) {
    test(`${name} is refused on create`, async () => {
      await publishBoth();
      await expect(
        service.createInvite(principal, { agentId: AGENT_X })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        service.createAccessKey(principal, { agentId: AGENT_X, label: "k" })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        service.addOutbound(principal, {
          agentId: AGENT_X,
          cardUrl: OUTSIDE_CARD_URL,
          credential: "x",
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        service.publish(principal, {
          agentId: AGENT_X,
          description: "d",
          skills: SKILLS,
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    test(`${name} is refused on approve`, async () => {
      const pending = await toNeedsApproval();
      await expect(
        approveAs(principal, pending.aliceId)
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(rowOf(pending.aliceId)?.status).toBe("needs_approval");
    });

    test(`${name} is refused on revoke, decline and refresh`, async () => {
      const pending = await toNeedsApproval();
      await expect(
        service.revoke(principal, pending.aliceId)
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        service.decline(principal, pending.aliceId)
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        service.refreshCard(principal, pending.aliceId)
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(rowOf(pending.aliceId)?.status).toBe("needs_approval");
    });

    test(`${name} is refused on widen`, async () => {
      const pending = await pairFully();
      await expect(
        service.setPolicies(principal, {
          connectionId: pending.aliceId,
          inboundPolicy: "auto",
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(rowOf(pending.aliceId)?.inboundPolicy).toBe("approve");
    });
  }

  test("a non-owner member is refused on approve and allowed on revoke", async () => {
    const pending = await toNeedsApproval();
    await expect(approveAs(memberA, pending.aliceId)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(rowOf(pending.aliceId)?.status).toBe("needs_approval");
    const revoked = await service.revoke(memberA, pending.aliceId);
    expect(revoked.status).toBe("revoked");
  });

  test("an org admin and the agent's owner may approve", async () => {
    const first = await toNeedsApproval();
    expect((await approveAs(adminA, first.aliceId)).status).toBe("active");
  });

  test("another workspace's connection is not found", async () => {
    const pending = await toNeedsApproval();
    await expect(
      service.revoke(ownerB, pending.aliceId)
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(service.get(ownerB, pending.aliceId)).rejects.toBeInstanceOf(
      ServiceError
    );
  });

  test("only a member who is not the owner may narrow, and widening needs the owner or an admin", async () => {
    const paired = await pairFully();
    await expect(
      service.setPolicies(memberA, {
        connectionId: paired.aliceId,
        inboundPolicy: "auto",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.setPolicies(memberA, {
        connectionId: paired.aliceId,
        hourlyLimit: 500,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.setPolicies(memberA, {
        connectionId: paired.aliceId,
        toolPolicy: "agent_rules",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    const off = await service.setPolicies(memberA, {
      connectionId: paired.aliceId,
      inboundPolicy: "off",
    });
    expect(off.inboundPolicy).toBe("off");
    // Turning it back on is widening.
    await expect(
      service.setPolicies(memberA, {
        connectionId: paired.aliceId,
        inboundPolicy: "approve",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    const widened = await service.setPolicies(ownerA, {
      connectionId: paired.aliceId,
      inboundPolicy: "auto",
      toolPolicy: "agent_rules",
    });
    expect(widened.inboundPolicy).toBe("auto");
    expect(widened.toolPolicy).toBe("agent_rules");
    const lowered = await service.setPolicies(memberA, {
      connectionId: paired.aliceId,
      hourlyLimit: 5,
    });
    expect(lowered.hourlyLimit).toBe(5);
  });
});

describe("revoking", () => {
  test("a revoke queues a notice to a Agentum peer and the peer's access ends on its notice", async () => {
    const paired = await pairFully();
    await service.revoke(memberA, paired.aliceId);
    const [notice] = await db
      .select()
      .from(a2aOutbox)
      .where(eq(a2aOutbox.kind, "pair_revoke"));
    expect(notice?.url).toEndWith("/pair/revoke");
    expect(notice?.connectionId).toBe(paired.aliceId);
    expect(await service.authenticate(paired.aliceToken)).toBeNull();
    // Bob learns of it with the credential Alice holds for him, which is his own inbound token.
    await service.peerRevoked(paired.bobToken);
    expect(rowOf(paired.bobId)?.status).toBe("revoked");
    expect(rowOf(paired.bobId)?.revokedBy).toBe("peer");
    expect(await service.authenticate(paired.bobToken)).toBeNull();
    // Bob sends nothing back.
    expect(
      await db
        .select()
        .from(a2aOutbox)
        .where(eq(a2aOutbox.connectionId, paired.bobId))
    ).toHaveLength(0);
  });

  test("the revoke hook fires once per connection", async () => {
    const paired = await pairFully();
    const seen: string[] = [];
    service.onRevoked((revoked) => {
      seen.push(`${revoked.connectionId}:${revoked.agentId}`);
      return Promise.resolve();
    });
    await service.revoke(memberA, paired.aliceId);
    await service.revoke(memberA, paired.aliceId);
    expect(seen).toEqual([`${paired.aliceId}:${AGENT_X}`]);
  });

  test("a hook that throws does not undo the revoke", async () => {
    const paired = await pairFully();
    service.onRevoked(() => Promise.reject(new Error("boom")));
    await service.revoke(memberA, paired.aliceId);
    expect(rowOf(paired.aliceId)?.status).toBe("revoked");
  });

  test("archiving an agent revokes its connections", async () => {
    const paired = await pairFully();
    const key = await service.createAccessKey(ownerA, {
      agentId: AGENT_X,
      label: "Hermes",
    });
    await agents.archive(adminA, AGENT_X);
    expect(rowOf(paired.aliceId)?.status).toBe("revoked");
    expect(rowOf(key.connection.id)?.status).toBe("revoked");
    expect(rowOf(paired.aliceId)?.revokedBy).toBe("u-admin");
    expect(await service.authenticate(key.token)).toBeNull();
    // Bob's agent is untouched.
    expect(rowOf(paired.bobId)?.status).toBe("active");
  });
});

describe("the peer principal", () => {
  test("is refused any action outside a2a.* and runs.start, and on runs.start for another agent", async () => {
    await publishBoth();
    const key = await service.createAccessKey(ownerA, {
      agentId: AGENT_X,
      label: "Hermes",
    });
    const peer = await service.authenticate(key.token);
    if (!peer) {
      throw new Error("expected a peer principal");
    }
    for (const action of [
      "runs.read",
      "runs.cancel",
      "events.read",
      "agents.read",
      "agents.update",
      "sessions.read",
      "requests.write",
      "secrets.read",
      "triggers.fire",
    ]) {
      expect(can(peer, action, { kind: "x", workspaceId: W_ALICE })).toBe(
        false
      );
    }
    expect(
      can(peer, "a2a.task.read", { kind: "x", workspaceId: W_ALICE })
    ).toBe(true);
    expect(can(peer, "runs.start", { kind: "x", workspaceId: W_ALICE })).toBe(
      true
    );
    expect(can(peer, "runs.start", { kind: "x", workspaceId: W_BOB })).toBe(
      false
    );
    await expect(deriveSubject(db, peer, AGENT_X2)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    const subject = await deriveSubject(db, { ...peer, hops: 9 }, AGENT_X);
    expect(subject).toEqual({
      actor: { id: key.connection.id, kind: "peer" },
      depth: 3,
      onBehalfOfUserId: null,
      parentRunId: null,
    });
    expect(eventActor(peer)).toEqual({
      id: key.connection.id,
      kind: "peer",
    });
    await expect(service.list(peer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.revoke(peer, key.connection.id)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("secrets at rest", () => {
  test("no plaintext token or credential is in the database or in event payloads", async () => {
    activateFails = true;
    const pending = await toNeedsApproval();
    await approveAs(ownerA, pending.aliceId);
    const outbound = await service.addOutbound(ownerA, {
      agentId: AGENT_X2,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    await publishBoth();
    const key = await service.createAccessKey(ownerA, {
      agentId: AGENT_X,
      label: "Hermes",
    });
    peerCard = outsideCard({
      securityRequirements: [{ schemes: { oauth: { list: [] } } }],
      securitySchemes: {
        oauth: {
          oauth2SecurityScheme: {
            flows: {
              clientCredentials: {
                scopes: {},
                tokenUrl: "https://idp.example.com/token",
              },
            },
          },
        },
      },
    });
    await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: "https://oauth.example.com/.well-known/agent-card.json",
      credential: { clientId: "client-id-123", clientSecret: OAUTH_SECRET },
    });
    expect(rowOf(outbound.id)?.outboundCredential).toStartWith("v1:");
    const inviteSecret = pending.inviteLink.split("/connect/")[1] ?? "";
    const [token] = await db
      .select()
      .from(a2aOutbox)
      .where(eq(a2aOutbox.kind, "pair_activate"));
    const secrets = [
      inviteSecret,
      inviteSecret.split(".")[1] ?? "",
      pending.bobToken,
      key.token,
      OUTSIDE_SECRET,
      OAUTH_SECRET,
      pending.inviteLink,
    ];
    const tables = db.client
      .query("select name from sqlite_master where type = 'table'")
      .all() as { name: string }[];
    let dump = "";
    for (const { name } of tables) {
      dump += JSON.stringify(db.client.query(`select * from "${name}"`).all());
    }
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThan(10);
      expect(dump).not.toContain(secret);
    }
    // The token the approval minted is only in the outbox, sealed.
    expect(token?.body).toContain("v1:");
    expect(dump).not.toContain(activations.at(-1)?.token ?? "missing");
    const logged = await db.select().from(eventRows);
    expect(logged.some((row) => row.type.startsWith("a2a."))).toBe(true);
  });

  test("every state change writes an a2a event naming no token", async () => {
    const paired = await pairFully();
    await service.setPolicies(ownerA, {
      connectionId: paired.aliceId,
      inboundPolicy: "auto",
    });
    await service.revoke(memberA, paired.aliceId);
    const types = (
      await db
        .select({ type: eventRows.type })
        .from(eventRows)
        .where(and(eq(eventRows.workspaceId, W_ALICE)))
    ).map((row) => row.type);
    for (const expected of [
      "a2a.agent_published",
      "a2a.invite_created",
      "a2a.connection_requested",
      "a2a.connection_approved",
      "a2a.policy_changed",
      "a2a.connection_revoked",
    ]) {
      expect(types).toContain(expected);
    }
    const bobTypes = (
      await db
        .select({ type: eventRows.type })
        .from(eventRows)
        .where(eq(eventRows.workspaceId, W_BOB))
    ).map((row) => row.type);
    expect(bobTypes).toContain("a2a.connection_created");
    expect(bobTypes).toContain("a2a.connection_activated");
    const stored = await db
      .select()
      .from(a2aAgentCards)
      .where(eq(a2aAgentCards.agentId, AGENT_X));
    expect(stored).toHaveLength(1);
  });
});

describe("hardening", () => {
  /** A service whose transport answers as the test says. */
  const withTransport = (join: PairingTransport["join"]) =>
    createConnectionsService({
      atomic: sqliteAtomic(db),
      clock,
      db,
      events,
      publicBaseUrl: BASE,
      secretsKey: SECRETS_KEY,
      transport: { activate: () => Promise.resolve(), join },
    });

  test("an inviter cannot answer with a card from another host than its link", async () => {
    await publishBoth();
    const invite = await service.createInvite(ownerA, { agentId: AGENT_X });
    const aliceCard = await publishedFor(ownerA, AGENT_X);
    const liar = withTransport(() =>
      Promise.resolve({
        agentName: "Agent X",
        cardUrl: aliceCard.cardUrl,
        orgName: "Alice Org",
      })
    );
    await expect(
      liar.joinWithLink(ownerB, {
        agentId: AGENT_Y,
        link: invite.link.replace(BASE, "https://evil.example"),
      })
    ).rejects.toBeInstanceOf(ServiceError);
    expect(await service.list(ownerB)).toHaveLength(0);
  });

  test("an OAuth token URL on a private address is refused", async () => {
    peerCard = outsideCard({
      securityRequirements: [{ schemes: { oauth: { list: [] } } }],
      securitySchemes: {
        oauth: {
          oauth2SecurityScheme: {
            flows: {
              clientCredentials: {
                scopes: {},
                tokenUrl: "http://169.254.169.254/latest/token",
              },
            },
          },
        },
      },
    });
    await expect(
      service.addOutbound(ownerA, {
        agentId: AGENT_X,
        cardUrl: OUTSIDE_CARD_URL,
        credential: { clientId: "id", clientSecret: "secret" },
      })
    ).rejects.toBeInstanceOf(ServiceError);
    expect(await db.select().from(a2aConnections)).toHaveLength(0);
  });

  test("a refresh that races a revoke leaves the connection revoked", async () => {
    let connectionId = "";
    const racing = createConnectionsService({
      atomic: sqliteAtomic(db),
      clock,
      db,
      events,
      fetchCard: async () => {
        await service.revoke(memberA, connectionId);
        return outsideCard({
          supportedInterfaces: [
            {
              protocolBinding: "JSONRPC",
              protocolVersion: "1.0",
              url: "https://elsewhere.example.org/rpc",
            },
          ],
        });
      },
      publicBaseUrl: BASE,
      secretsKey: SECRETS_KEY,
    });
    connectionId = (
      await service.addOutbound(ownerA, {
        agentId: AGENT_X,
        cardUrl: OUTSIDE_CARD_URL,
        credential: OUTSIDE_SECRET,
      })
    ).id;
    const refreshed = await racing.refreshCard(ownerA, connectionId);
    expect(refreshed.status).toBe("revoked");
    await expect(approveAs(ownerA, connectionId)).rejects.toBeInstanceOf(
      ServiceError
    );
  });

  test("a changed credential scheme sends the connection back to a person", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    peerCard = outsideCard({
      securityRequirements: [],
      securitySchemes: undefined,
    });
    const refreshed = await service.refreshCard(ownerA, connection.id);
    expect(refreshed.status).toBe("needs_approval");
    await expect(approveAs(ownerA, connection.id)).rejects.toBeInstanceOf(
      ServiceError
    );
  });

  test("a repeated activation with the same token succeeds and another token does not", async () => {
    const paired = await pairFully();
    await service.activate(paired.bobToken, { token: paired.aliceToken });
    await expect(
      service.activate(paired.bobToken, { token: "hm_a2a_".padEnd(48, "q") })
    ).rejects.toBeInstanceOf(ServiceError);
    expect(rowOf(paired.bobId)?.status).toBe("active");
  });

  test("a revoke from needs_approval reaches a joiner still waiting", async () => {
    const pending = await toNeedsApproval();
    await service.revoke(memberA, pending.aliceId);
    const [notice] = await db
      .select()
      .from(a2aOutbox)
      .where(eq(a2aOutbox.kind, "pair_revoke"));
    expect(notice?.connectionId).toBe(pending.aliceId);
    await service.peerRevoked(pending.bobToken);
    expect(rowOf(pending.bobId)?.status).toBe("revoked");
    // A retried notice is not an error.
    await service.peerRevoked(pending.bobToken);
  });

  test("a notice that cannot be queued does not skip the event or the hook", async () => {
    const paired = await pairFully();
    const wrongKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    const unreadable = createConnectionsService({
      atomic: sqliteAtomic(db),
      clock,
      db,
      events,
      publicBaseUrl: BASE,
      secretsKey: wrongKey,
    });
    const seen: string[] = [];
    unreadable.onRevoked((revoked) => {
      seen.push(revoked.connectionId);
      return Promise.resolve();
    });
    await unreadable.revoke(memberA, paired.aliceId);
    expect(rowOf(paired.aliceId)?.status).toBe("revoked");
    expect(seen).toEqual([paired.aliceId]);
    const logged = await db
      .select()
      .from(eventRows)
      .where(eq(eventRows.type, "a2a.connection_revoked"));
    expect(logged).toHaveLength(1);
  });

  test("an agent's owner takes precedence over the person who created it", async () => {
    db.update(agentRows)
      .set({ ownerUserId: "u-delegate" })
      .where(eq(agentRows.id, AGENT_X))
      .run();
    // The creator is no longer the owner, so the creator cannot publish.
    await expect(
      service.publish(ownerA, {
        agentId: AGENT_X,
        description: "d",
        skills: SKILLS,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    const delegate = session("u-delegate", W_ALICE);
    await service.publish(delegate, {
      agentId: AGENT_X,
      description: "d",
      skills: SKILLS,
    });
  });
});

describe("hardening, round two", () => {
  const oauthCard = (
    tokenUrl: string,
    rpcUrl = "https://agent.example.com/rpc"
  ) =>
    outsideCard({
      securityRequirements: [{ schemes: { oauth: { list: [] } } }],
      securitySchemes: {
        oauth: {
          oauth2SecurityScheme: {
            flows: { clientCredentials: { scopes: {}, tokenUrl } },
          },
        },
      },
      supportedInterfaces: [
        { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: rpcUrl },
      ],
    });

  const addOauth = async () => {
    peerCard = oauthCard("https://idp.example.com/token");
    return await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: { clientId: "client-id-123", clientSecret: OAUTH_SECRET },
    });
  };

  test("a decline whose notice cannot be queued still records the event and fires the hook", async () => {
    const pending = await toNeedsApproval();
    const wrongKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    const unreadable = createConnectionsService({
      atomic: sqliteAtomic(db),
      clock,
      db,
      events,
      publicBaseUrl: BASE,
      secretsKey: wrongKey,
    });
    const seen: string[] = [];
    unreadable.onRevoked((ended) => {
      seen.push(ended.connectionId);
      return Promise.resolve();
    });
    await unreadable.decline(memberA, pending.aliceId);
    expect(rowOf(pending.aliceId)?.status).toBe("declined");
    expect(seen).toEqual([pending.aliceId]);
    const logged = await db
      .select()
      .from(eventRows)
      .where(
        and(
          eq(eventRows.type, "a2a.connection_declined"),
          eq(eventRows.workspaceId, W_ALICE)
        )
      );
    expect(logged).toHaveLength(1);
  });

  test("approving a moved OAuth token URL on a private address is refused", async () => {
    const connection = await addOauth();
    peerCard = oauthCard("https://169.254.169.254/token");
    expect((await service.refreshCard(ownerA, connection.id)).status).toBe(
      "needs_approval"
    );
    await expect(approveAs(ownerA, connection.id)).rejects.toBeInstanceOf(
      ServiceError
    );
    expect(rowOf(connection.id)?.status).toBe("needs_approval");
  });

  test("approving a moved OAuth token URL seals the new URL into the credential", async () => {
    const connection = await addOauth();
    peerCard = oauthCard("https://idp2.example.com/token");
    await service.refreshCard(ownerA, connection.id);
    await approveAs(ownerA, connection.id);
    const key = await importSecretsKey(SECRETS_KEY);
    const row = rowOf(connection.id);
    const plain = await decryptSecret(
      key,
      {
        field: "outbound_credential",
        rowId: connection.id,
        table: "a2a_connections",
        workspaceId: W_ALICE,
      },
      row?.outboundCredential ?? ""
    );
    expect(JSON.parse(plain)).toEqual({
      clientId: "client-id-123",
      clientSecret: OAUTH_SECRET,
      scopes: [],
      tokenUrl: "https://idp2.example.com/token",
    });
    expect(row?.status).toBe("active");
  });

  test("a card that moves a second time while a person looks is logged and shown", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    const moveTo = (rpcUrl: string) =>
      outsideCard({
        supportedInterfaces: [
          { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: rpcUrl },
        ],
      });
    peerCard = moveTo("https://decoy.example.com/rpc");
    const first = await service.refreshCard(ownerA, connection.id);
    expect(first.pendingOrigin).toBe("https://decoy.example.com");
    // The same card again is not news.
    await service.refreshCard(ownerA, connection.id);
    peerCard = moveTo("https://other.example.net/rpc");
    const second = await service.refreshCard(ownerA, connection.id);
    expect(second.status).toBe("needs_approval");
    expect(second.pendingOrigin).toBe("https://other.example.net");
    expect(second.peerOrigin).toBe("https://agent.example.com");
    const logged = await db
      .select()
      .from(eventRows)
      .where(eq(eventRows.type, "a2a.connection_reapproval_needed"));
    expect(logged).toHaveLength(2);
  });

  test("an activation the outbox gave up on ends the row", async () => {
    activateFails = true;
    const pending = await toNeedsApproval();
    await approveAs(ownerA, pending.aliceId);
    await expect(
      service.activationAbandoned(ownerA, pending.aliceId)
    ).rejects.toBeInstanceOf(ForbiddenError);
    await service.activationAbandoned(SYSTEM_PRINCIPAL, pending.aliceId);
    expect(rowOf(pending.aliceId)?.status).toBe("revoked");
    expect(await db.select().from(a2aOutbox)).toHaveLength(0);
  });

  test("a token URL that moves host on the same origin goes back to a person and nothing is sealed to it before approval", async () => {
    const connection = await addOauth();
    peerCard = oauthCard("https://evil.example.net/token");
    const refreshed = await service.refreshCard(ownerA, connection.id);
    expect(refreshed.status).toBe("needs_approval");
    expect(refreshed.peerOrigin).toBe("https://agent.example.com");
    expect(refreshed.pendingOrigin).toBe("https://agent.example.com");
    expect(refreshed.tokenUrl).toBe("https://idp.example.com/token");
    expect(refreshed.pendingTokenUrl).toBe("https://evil.example.net/token");
    const logged = await db
      .select()
      .from(eventRows)
      .where(eq(eventRows.type, "a2a.connection_reapproval_needed"));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]?.payload ?? "{}")).toMatchObject({
      fromTokenUrl: "https://idp.example.com/token",
      reason: "scheme",
      toTokenUrl: "https://evil.example.net/token",
    });
    // Still the approved destination in the row and in the sealed credential.
    const row = rowOf(connection.id);
    expect(row?.outboundScheme).toBe(
      "oauth2_client_credentials:https://idp.example.com/token"
    );
    const key = await importSecretsKey(SECRETS_KEY);
    const sealed = JSON.parse(
      await decryptSecret(
        key,
        {
          field: "outbound_credential",
          rowId: connection.id,
          table: "a2a_connections",
          workspaceId: W_ALICE,
        },
        row?.outboundCredential ?? ""
      )
    ) as { tokenUrl: string };
    expect(sealed.tokenUrl).toBe("https://idp.example.com/token");
    // An approval that carries the old token URL is refused.
    await expect(
      service.approve(ownerA, connection.id, {
        origin: "https://agent.example.com",
        tokenUrl: "https://idp.example.com/token",
      })
    ).rejects.toBeInstanceOf(ServiceError);
    expect(rowOf(connection.id)?.status).toBe("needs_approval");
  });

  test("an approval carrying a stale destination is refused", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    const moveTo = (rpcUrl: string) =>
      outsideCard({
        supportedInterfaces: [
          { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: rpcUrl },
        ],
      });
    peerCard = moveTo("https://decoy.example.com/rpc");
    await service.refreshCard(ownerA, connection.id);
    const shown = await seenOf(connection.id);
    expect(shown).toEqual({
      origin: "https://decoy.example.com",
      tokenUrl: null,
    });
    peerCard = moveTo("https://other.example.net/rpc");
    await service.refreshCard(ownerA, connection.id);
    await expect(
      service.approve(ownerA, connection.id, shown)
    ).rejects.toBeInstanceOf(ServiceError);
    expect(rowOf(connection.id)?.status).toBe("needs_approval");
    expect(rowOf(connection.id)?.peerOrigin).toBe("https://agent.example.com");
    // What the page shows now is approved.
    const approved = await approveAs(ownerA, connection.id);
    expect(approved.peerOrigin).toBe("https://other.example.net");
  });

  test("a pairing approval with the wrong origin or a token URL is refused", async () => {
    const pending = await toNeedsApproval();
    const shown = await seenOf(pending.aliceId);
    await expect(
      service.approve(ownerA, pending.aliceId, {
        origin: "https://elsewhere.example.org",
        tokenUrl: null,
      })
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(
      service.approve(ownerA, pending.aliceId, {
        ...shown,
        tokenUrl: "https://idp.example.com/token",
      })
    ).rejects.toBeInstanceOf(ServiceError);
    expect(rowOf(pending.aliceId)?.status).toBe("needs_approval");
    expect(rowOf(pending.aliceId)?.inboundTokenHash).toBeNull();
    expect((await service.approve(ownerA, pending.aliceId, shown)).status).toBe(
      "active"
    );
  });

  test("a refresh that races an approval does not store a card the person never saw", async () => {
    const connection = await addOauth();
    peerCard = oauthCard("https://idp2.example.com/token");
    await service.refreshCard(ownerA, connection.id);
    const racing = createConnectionsService({
      atomic: sqliteAtomic(db),
      clock,
      db,
      events,
      fetchCard: async () => {
        await approveAs(ownerA, connection.id);
        return oauthCard("https://idp3.example.com/token");
      },
      publicBaseUrl: BASE,
      secretsKey: SECRETS_KEY,
    });
    await racing.refreshCard(ownerA, connection.id);
    const row = rowOf(connection.id);
    expect(row?.status).toBe("active");
    expect(row?.outboundScheme).toBe(
      "oauth2_client_credentials:https://idp2.example.com/token"
    );
    expect(row?.peerCard).toContain("idp2.example.com");
    expect(row?.peerCard).not.toContain("idp3.example.com");
    // The next refresh sees the new URL against the approved one and asks again.
    peerCard = oauthCard("https://idp3.example.com/token");
    expect((await service.refreshCard(ownerA, connection.id)).status).toBe(
      "needs_approval"
    );
  });

  test("an unreadable credential on approve is a conflict, not a crash", async () => {
    const connection = await addOauth();
    peerCard = oauthCard("https://idp2.example.com/token");
    await service.refreshCard(ownerA, connection.id);
    const wrongKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    const unreadable = createConnectionsService({
      atomic: sqliteAtomic(db),
      clock,
      db,
      events,
      publicBaseUrl: BASE,
      secretsKey: wrongKey,
    });
    await expect(
      unreadable.approve(ownerA, connection.id, await seenOf(connection.id))
    ).rejects.toBeInstanceOf(ServiceError);
  });

  test("a corrupt stored card does not break the list", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    db.update(a2aConnections)
      .set({ peerCard: "{not json", status: "needs_approval" })
      .where(eq(a2aConnections.id, connection.id))
      .run();
    const listed = await service.list(ownerA);
    expect(
      listed.find((c) => c.id === connection.id)?.pendingOrigin
    ).toBeNull();
  });

  test("activationAbandoned does nothing to a connection that is not activating", async () => {
    const paired = await pairFully();
    await service.activationAbandoned(SYSTEM_PRINCIPAL, paired.aliceId);
    expect(rowOf(paired.aliceId)?.status).toBe("active");
  });

  test("two overlapping refreshes log once, and the dropped one logs nothing", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    const moveTo = (rpcUrl: string) =>
      outsideCard({
        supportedInterfaces: [
          { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: rpcUrl },
        ],
      });
    const quick = createConnectionsService({
      atomic: sqliteAtomic(db),
      clock,
      db,
      events,
      fetchCard: () => Promise.resolve(moveTo("https://first.example.com/rpc")),
      publicBaseUrl: BASE,
      secretsKey: SECRETS_KEY,
    });
    // The slow refresh read the connection first. While it waits for its card,
    // the quick one finishes.
    const slow = createConnectionsService({
      atomic: sqliteAtomic(db),
      clock,
      db,
      events,
      fetchCard: async () => {
        await quick.refreshCard(SYSTEM_PRINCIPAL, connection.id);
        return moveTo("https://second.example.net/rpc");
      },
      publicBaseUrl: BASE,
      secretsKey: SECRETS_KEY,
    });
    const refreshed = await slow.refreshCard(ownerA, connection.id);
    expect(refreshed.status).toBe("needs_approval");
    expect(refreshed.pendingOrigin).toBe("https://first.example.com");
    const logged = await db
      .select()
      .from(eventRows)
      .where(eq(eventRows.type, "a2a.connection_reapproval_needed"));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]?.payload ?? "{}")).toMatchObject({
      toOrigin: "https://first.example.com",
    });
  });

  test("two refreshes that read the same moved card log once, and the slow one writes nothing", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    peerCard = outsideCard({
      supportedInterfaces: [
        {
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
          url: "https://first.example.com/rpc",
        },
      ],
    });
    await service.refreshCard(ownerA, connection.id);
    // Both refreshes now read needs_approval with the card that moved to first.
    const quick = serviceFetching(() =>
      Promise.resolve(
        outsideCard({
          supportedInterfaces: [
            {
              protocolBinding: "JSONRPC",
              protocolVersion: "1.0",
              url: "https://second.example.net/rpc",
            },
          ],
        })
      )
    );
    const slow = serviceFetching(async () => {
      await quick.refreshCard(ownerA, connection.id);
      return outsideCard({
        supportedInterfaces: [
          {
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
            url: "https://third.example.org/rpc",
          },
        ],
      });
    });
    const refreshed = await slow.refreshCard(ownerA, connection.id);
    expect(refreshed.status).toBe("needs_approval");
    expect(refreshed.pendingOrigin).toBe("https://second.example.net");
    const logged = await db
      .select()
      .from(eventRows)
      .where(eq(eventRows.type, "a2a.connection_reapproval_needed"));
    // The first flip and the quick refresh's move, not the slow one's.
    expect(logged).toHaveLength(2);
  });

  test("a refresh that read the card before an approval does not put the connection back to needs_approval", async () => {
    const connection = await service.addOutbound(ownerA, {
      agentId: AGENT_X,
      cardUrl: OUTSIDE_CARD_URL,
      credential: OUTSIDE_SECRET,
    });
    const quick = serviceFetching(() =>
      Promise.resolve(
        outsideCard({
          supportedInterfaces: [
            {
              protocolBinding: "JSONRPC",
              protocolVersion: "1.0",
              url: "https://first.example.com/rpc",
            },
          ],
        })
      )
    );
    // The slow refresh read the active connection. While its card loads, the
    // card moves, a person approves the move, and only then does the slow one
    // finish with a card that moves again.
    const slow = serviceFetching(async () => {
      await quick.refreshCard(ownerA, connection.id);
      await approveAs(ownerA, connection.id);
      return outsideCard({
        supportedInterfaces: [
          {
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
            url: "https://second.example.net/rpc",
          },
        ],
      });
    });
    const refreshed = await slow.refreshCard(ownerA, connection.id);
    expect(refreshed.status).toBe("active");
    expect(refreshed.peerOrigin).toBe("https://first.example.com");
    expect(rowOf(connection.id)?.status).toBe("active");
    const logged = await db
      .select()
      .from(eventRows)
      .where(eq(eventRows.type, "a2a.connection_reapproval_needed"));
    // Only the quick refresh's flip is logged.
    expect(logged).toHaveLength(1);
  });
});
