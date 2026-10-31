import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import {
  a2aAgentCards,
  a2aConnections,
  a2aPairingRequests,
} from "@repo/db/schema/a2a";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { hashToken } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import { createEventsService } from "../events.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import {
  type ConnectionsService,
  createConnectionsService,
} from "./connections.ts";
import {
  PAIRING_LOCKOUT_MS,
  PAIRING_MAX_FAILURES,
  PAIRING_MAX_PENDING,
  PAIRING_REQUEST_TTL_MS,
} from "./pairing.ts";
import { PAIRING_ALPHABET } from "./pairing-code.ts";

const BASE = "https://hm.test";
const START = "2026-11-01T10:00:00.000Z";
const SECRETS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const W = "w-alice";
const W_OTHER = "w-bob";
const AGENT = "a-x";
const AGENT_TWO = "a-x2";
const OTHER_AGENT = "a-y";
const LOCKED = /locked/i;
const NOT_VALID = /not valid or has expired/;
const PUBLISH_FIRST = /Publish the agent first/;
const CODE = new RegExp(`^[${PAIRING_ALPHABET}]{8}$`);
const SKILLS = [
  {
    description: "Answers questions.",
    id: "ask",
    name: "Ask",
    tags: ["support"],
  },
];

const session = (userId: string, workspaceId: string, isAdmin = false) =>
  ({ isAdmin, kind: "user", userId, via: "session", workspaceId }) as const;

const admin = session("u-admin", W, true);
const owner = session("u-owner", W);
const member = session("u-member", W);
const otherAdmin = session("u-bob", W_OTHER, true);

const tokenOf = (n: number): string => `pairing-token-${n}-`.padEnd(48, "x");

let db: ReturnType<typeof migrated>;
let nowMs: number;
let clock: Clock;
let service: ConnectionsService;
let publicId: string;

const seedAgent = (id: string, workspaceId: string, createdBy: string) =>
  db
    .insert(agentRows)
    .values({
      createdAt: START,
      createdBy,
      id,
      instructions: "x",
      model: "m",
      name: id,
      runtime: "fake",
      runtimeConfig: "{}",
      slug: id,
      status: "active",
      workspaceId,
    })
    .run();

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse(START);
  clock = { now: () => new Date(nowMs), sleep: () => Promise.resolve() };
  for (const [id, name] of [
    [W, "Alice Org"],
    [W_OTHER, "Bob Org"],
  ] as const) {
    db.insert(workspaceRows)
      .values({
        clerkOrgId: `org_${id}`,
        createdAt: START,
        id,
        name,
        timezone: "UTC",
      })
      .run();
  }
  seedAgent(AGENT, W, "u-owner");
  seedAgent(AGENT_TWO, W, "u-owner");
  seedAgent(OTHER_AGENT, W_OTHER, "u-bob");
  const store = new Map<string, string>();
  const events = createEventsService({
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    db,
  });
  service = createConnectionsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    publicBaseUrl: BASE,
    secretsKey: SECRETS_KEY,
  });
  const card = await service.publish(owner, {
    agentId: AGENT,
    description: "Agent X answers questions.",
    skills: SKILLS,
  });
  ({ publicId } = card);
});

const open = () =>
  service.setPairingOpen(owner, { agentId: AGENT, open: true });

/** A request that was answered with a code. */
const request = async (token: string): Promise<string> => {
  const code = await service.requestPairing(AGENT, token);
  if (code === null) {
    throw new Error("The request was refused");
  }
  return code;
};

const approve = (code: string, label = "Hermes on Sam's box") =>
  service.approvePairingCode(owner, { agentId: AGENT, code, label });

const requests = () => db.select().from(a2aPairingRequests).all();
const card = () =>
  db.select().from(a2aAgentCards).where(eq(a2aAgentCards.agentId, AGENT)).get();
const typeCount = (type: string) =>
  db.select().from(eventRows).where(eq(eventRows.type, type)).all().length;

const wrongCodes = async (count: number) => {
  for (let i = 0; i < count; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each wrong code counts after the one before
    const refused = await approve("AAAAAAAA").then(
      () => false,
      () => true
    );
    if (!refused) {
      throw new Error("A wrong code was accepted");
    }
  }
};

describe("a request", () => {
  test("is refused with pairing off, and writes nothing", async () => {
    expect(await service.pairableAgent(publicId)).toBeNull();
    expect(await service.requestPairing(AGENT, tokenOf(1))).toBeNull();
    expect(requests()).toHaveLength(0);
    expect(typeCount("a2a.pairing_requested")).toBe(0);
  });

  test("is refused for a token under 32 characters, and writes nothing", async () => {
    await open();
    expect(await service.requestPairing(AGENT, "x".repeat(31))).toBeNull();
    expect(requests()).toHaveLength(0);
    expect(await service.requestPairing(AGENT, "x".repeat(32))).not.toBeNull();
  });

  test("gets an 8-character code, stored only as a hash", async () => {
    await open();
    expect(await service.pairableAgent(publicId)).toBe(AGENT);
    const code = await request(tokenOf(1));
    expect(code).toMatch(CODE);
    const [row] = requests();
    expect(row?.codeHash).toBe(await hashToken(code));
    expect(row?.tokenHash).toBe(await hashToken(tokenOf(1)));
    expect(JSON.stringify(row)).not.toContain(code);
    expect(JSON.stringify(row)).not.toContain(tokenOf(1));
  });

  test("with the same token gets the same code back, and one row", async () => {
    await open();
    const first = await request(tokenOf(1));
    expect(await request(tokenOf(1))).toBe(first);
    expect(requests()).toHaveLength(1);
    expect(typeCount("a2a.pairing_requested")).toBe(1);
    expect(await request(tokenOf(2))).not.toBe(first);
  });

  test("a fourth pending request is refused until one goes", async () => {
    await open();
    for (let n = 1; n <= PAIRING_MAX_PENDING; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: requests come one after another
      await request(tokenOf(n));
    }
    expect(await service.requestPairing(AGENT, tokenOf(4))).toBeNull();
    expect(requests()).toHaveLength(PAIRING_MAX_PENDING);
    // A token that already asked still gets its code.
    expect(await service.requestPairing(AGENT, tokenOf(1))).not.toBeNull();
    nowMs += PAIRING_REQUEST_TTL_MS;
    expect(await service.requestPairing(AGENT, tokenOf(4))).not.toBeNull();
  });

  test("a token that belongs to a connection can't be paired again", async () => {
    await open();
    const key = await service.createAccessKey(owner, {
      agentId: AGENT,
      label: "Key",
    });
    expect(await service.requestPairing(AGENT, key.token)).toBeNull();
    const code = await request(tokenOf(1));
    await approve(code);
    expect(await service.requestPairing(AGENT, tokenOf(1))).toBeNull();
    expect(requests()).toHaveLength(0);
  });

  test("is refused while the agent is unpublished", async () => {
    await open();
    await service.unpublish(owner, AGENT);
    expect(await service.pairableAgent(publicId)).toBeNull();
    expect(await service.requestPairing(AGENT, tokenOf(1))).toBeNull();
  });
});

describe("expiry", () => {
  test("a code expires after 1 hour", async () => {
    await open();
    const code = await request(tokenOf(1));
    nowMs += PAIRING_REQUEST_TTL_MS - 1;
    // Still good a millisecond before the hour is up: do not spend it.
    expect(await request(tokenOf(1))).toBe(code);
    nowMs += 1;
    await expect(approve(code)).rejects.toBeInstanceOf(ServiceError);
    expect(a2aConnectionRows()).toHaveLength(0);
  });

  test("the same token asks again after expiry and gets a new code", async () => {
    await open();
    const code = await request(tokenOf(1));
    nowMs += PAIRING_REQUEST_TTL_MS;
    const again = await request(tokenOf(1));
    expect(again).not.toBe(code);
    expect(requests()).toHaveLength(1);
    await expect(approve(code)).rejects.toBeInstanceOf(ServiceError);
    await approve(again);
  });
});

const a2aConnectionRows = () => db.select().from(a2aConnections).all();

describe("lockout", () => {
  test("5 wrong codes lock pairing, and a right code is refused while it lasts", async () => {
    await open();
    const code = await request(tokenOf(1));
    await wrongCodes(PAIRING_MAX_FAILURES);
    expect(typeCount("a2a.pairing_code_wrong")).toBe(PAIRING_MAX_FAILURES - 1);
    expect(typeCount("a2a.pairing_locked")).toBe(1);
    await expect(approve(code)).rejects.toThrow(LOCKED);
    expect(a2aConnectionRows()).toHaveLength(0);
    // Nobody new can ask while it is locked.
    expect(await service.pairableAgent(publicId)).toBeNull();
    expect(await service.requestPairing(AGENT, tokenOf(2))).toBeNull();
    nowMs += PAIRING_LOCKOUT_MS - 1;
    await expect(approve(code)).rejects.toThrow(LOCKED);
  });

  test("the lock ends after 1 hour and the count starts again", async () => {
    await open();
    await wrongCodes(PAIRING_MAX_FAILURES);
    nowMs += PAIRING_LOCKOUT_MS;
    const code = await request(tokenOf(1));
    await wrongCodes(PAIRING_MAX_FAILURES - 1);
    // Four wrong codes since the lock ended is not a lock.
    const connection = await approve(code);
    expect(connection.status).toBe("active");
    expect(card()?.pairingFailures).toBe(0);
  });

  test("a right code clears the count of wrong ones", async () => {
    await open();
    await wrongCodes(PAIRING_MAX_FAILURES - 1);
    await approve(await request(tokenOf(1)));
    await wrongCodes(PAIRING_MAX_FAILURES - 1);
    expect(typeCount("a2a.pairing_locked")).toBe(0);
  });
});

describe("approval", () => {
  test("creates an a2a_inbound connection under the default policies, and the token works once", async () => {
    await open();
    const code = await request(tokenOf(1));
    expect(await service.authenticate(tokenOf(1), publicId)).toBeNull();
    const connection = await approve(code.toLowerCase(), "  Hermes  ");
    expect(connection).toMatchObject({
      agentId: AGENT,
      approvedBy: "u-owner",
      inboundPolicy: "approve",
      peerKind: "a2a_inbound",
      peerLabel: "Hermes",
      status: "active",
      toolPolicy: "ask",
    });
    const peer = await service.authenticate(tokenOf(1), publicId);
    expect(peer).toMatchObject({
      agentId: AGENT,
      connectionId: connection.id,
      kind: "peer",
      workspaceId: W,
    });
    const [row] = a2aConnectionRows();
    expect(row?.inboundTokenHash).toBe(await hashToken(tokenOf(1)));
    expect(requests()).toHaveLength(0);
    await expect(approve(code)).rejects.toBeInstanceOf(ServiceError);
    expect(a2aConnectionRows()).toHaveLength(1);
  });

  test("the token works only under its own agent's path", async () => {
    await open();
    await approve(await request(tokenOf(1)));
    const other = await service.publish(owner, {
      agentId: AGENT_TWO,
      description: "Agent two.",
      skills: SKILLS,
    });
    expect(await service.authenticate(tokenOf(1), other.publicId)).toBeNull();
    expect(await service.authenticate(tokenOf(1))).not.toBeNull();
  });

  test("revoking the connection ends the token, and the token is not paired again", async () => {
    await open();
    const connection = await approve(await request(tokenOf(1)));
    await service.revoke(member, connection.id);
    expect(await service.authenticate(tokenOf(1), publicId)).toBeNull();
    // The hash still belongs to the revoked connection, so it is not reused.
    expect(await service.requestPairing(AGENT, tokenOf(1))).toBeNull();
  });

  test("a wrong code is refused and counted", async () => {
    await open();
    await request(tokenOf(1));
    await expect(approve("BBBBBBBB")).rejects.toThrow(NOT_VALID);
    expect(card()?.pairingFailures).toBe(1);
  });
});

describe("who may act", () => {
  const refused: [string, Principal][] = [
    [
      "a run principal",
      { agentId: AGENT, kind: "run", runId: "r1", workspaceId: W },
    ],
    [
      "an API key",
      {
        apiKey: { access: "write", id: "key1" },
        isAdmin: true,
        kind: "user",
        userId: "u-admin",
        via: "api_key",
        workspaceId: W,
      },
    ],
    [
      "an OAuth client",
      {
        isAdmin: true,
        kind: "user",
        oauthClient: { access: "write", clientId: "c1" },
        userId: "u-admin",
        via: "oauth",
        workspaceId: W,
      },
    ],
    [
      "a peer",
      { agentId: AGENT, connectionId: "con_x", kind: "peer", workspaceId: W },
    ],
  ];

  for (const [name, principal] of refused) {
    test(`${name} is refused on the switch`, async () => {
      await expect(
        service.setPairingOpen(principal, { agentId: AGENT, open: true })
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(card()?.pairingOpen).toBe(false);
    });

    test(`${name} is refused on approval, and the code stays good`, async () => {
      await open();
      const code = await request(tokenOf(1));
      await expect(
        service.approvePairingCode(principal, {
          agentId: AGENT,
          code,
          label: "x",
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(card()?.pairingFailures).toBe(0);
      expect(requests()).toHaveLength(1);
      await approve(code);
    });
  }

  test("a plain member is refused, the owner and an admin of the org are not", async () => {
    await expect(
      service.setPairingOpen(member, { agentId: AGENT, open: true })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await service.setPairingOpen(admin, { agentId: AGENT, open: true });
    const code = await request(tokenOf(1));
    await expect(
      service.approvePairingCode(member, { agentId: AGENT, code, label: "x" })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await service.approvePairingCode(admin, {
      agentId: AGENT,
      code,
      label: "x",
    });
  });

  test("another workspace's admin can't reach the agent", async () => {
    await expect(
      service.setPairingOpen(otherAdmin, { agentId: AGENT, open: true })
    ).rejects.toThrow();
    expect(card()?.pairingOpen).toBe(false);
  });

  test("an agent that is not published has no switch", async () => {
    await expect(
      service.setPairingOpen(owner, { agentId: AGENT_TWO, open: true })
    ).rejects.toThrow(PUBLISH_FIRST);
  });
});

describe("the switch", () => {
  test("turning it off drops the pending requests, so their codes stop working", async () => {
    await open();
    const code = await request(tokenOf(1));
    const closed = await service.setPairingOpen(owner, {
      agentId: AGENT,
      open: false,
    });
    expect(closed.pairingOpen).toBe(false);
    expect(requests()).toHaveLength(0);
    await expect(approve(code)).rejects.toBeInstanceOf(ServiceError);
    expect(await service.requestPairing(AGENT, tokenOf(2))).toBeNull();
  });
});

describe("the log", () => {
  test("holds an event for each step and no code, token or hash of either", async () => {
    await open();
    const code = await request(tokenOf(1));
    await request(tokenOf(1));
    await expect(approve("CCCCCCCC")).rejects.toBeInstanceOf(ServiceError);
    await approve(code);
    await wrongCodes(PAIRING_MAX_FAILURES);
    await service.setPairingOpen(owner, { agentId: AGENT, open: false });
    for (const type of [
      "a2a.pairing_switched",
      "a2a.pairing_requested",
      "a2a.pairing_code_wrong",
      "a2a.pairing_locked",
      "a2a.pairing_approved",
    ]) {
      expect(typeCount(type)).toBeGreaterThan(0);
    }
    expect(typeCount("a2a.pairing_requested")).toBe(1);
    const logged = JSON.stringify(db.select().from(eventRows).all());
    const secrets = [
      code,
      "CCCCCCCC",
      "AAAAAAAA",
      tokenOf(1),
      await hashToken(code),
      await hashToken(tokenOf(1)),
    ];
    expect(secrets.filter((secret) => logged.includes(secret))).toEqual([]);
  });
});
