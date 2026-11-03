import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { a2aConnections } from "@repo/db/schema/a2a";
import {
  type ConnectionsService,
  createConnectionsService,
  type PairingTransport,
} from "@repo/services/a2a/connections";
import { systemClock } from "@repo/services/runs/types";
import { eq } from "drizzle-orm";
import {
  type A2aFixture,
  createA2aFixture,
  ORIGIN,
  type Published,
  SECRETS_KEY,
} from "./a2a-fixture.ts";

const JOIN_PATH = "/a2a/pair/join";
const WWW_AUTHENTICATE = 'Bearer realm="agentum"';
const INVALID_INVITE = "This invite is not valid.";
const NOT_FOUND = "Connection not found";
const NOT_WAITING = "Connection is not waiting for activation";
const TOKEN_BYTES = 20;

/** A bearer in the shape of an access key: `hm_a2a_` and 40 random characters. */
const randomAccessToken = (): string =>
  `hm_a2a_${Array.from(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

/** The same invite with its secret changed and its connection id kept. */
const wrongSecret = (inviteToken: string): string =>
  `${inviteToken.slice(0, -1)}${inviteToken.endsWith("A") ? "B" : "A"}`;

let f: A2aFixture;
let x: Published;
let y: Published;
/** Alice's side for the approval, and Bob's side for the join. Both run over the same database. */
let peer: ConnectionsService;
let captured: {
  activations: { bearer: string; token: string; url: string }[];
  joins: string[];
};

/**
 * The transport the two sides of a pairing share. `join` and `activate` both
 * go over the real `/a2a` routes of the fixture app, so a refusal from the
 * route surfaces as an error here, the way a failed HTTP call would.
 */
const peerTransport = (): PairingTransport => ({
  activate: async ({ bearer, token, url }) => {
    captured.activations.push({ bearer, token, url });
    const res = await f.app.request(new URL(url).pathname, {
      body: JSON.stringify({ token }),
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(`The peer refused the activation: ${res.status}.`);
    }
  },
  join: async ({ body, inviteToken }) => {
    captured.joins.push(body.token);
    const res = await f.app.request(JOIN_PATH, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${inviteToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(`The inviter refused the join: ${res.status}.`);
    }
    return await res.json();
  },
});

beforeEach(async () => {
  f = await createA2aFixture();
  x = await f.publish("agent-x");
  y = await f.publish("agent-y", f.bob);
  captured = { activations: [], joins: [] };
  peer = createConnectionsService({
    atomic: sqliteAtomic(f.db),
    clock: systemClock,
    db: f.db,
    events: f.composed.services.events,
    publicBaseUrl: ORIGIN,
    secretsKey: SECRETS_KEY,
    transport: peerTransport(),
  });
});

const rowOf = (id: string) => {
  const row = f.db
    .select()
    .from(a2aConnections)
    .where(eq(a2aConnections.id, id))
    .get();
  if (!row) {
    throw new Error(`No connection ${id}.`);
  }
  return row;
};

const pairPost = (path: string, token: string | null, rawBody: string) =>
  f.app.request(path, {
    body: rawBody,
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    method: "POST",
  });

const joinBody = (token = randomAccessToken()) =>
  JSON.stringify({
    agentName: "Hermes",
    cardUrl: `${ORIGIN}/a2a/${y.publicId}/.well-known/agent-card.json`,
    token,
  });

/** Alice makes an invite for X. The invite's secret is the last part of the link. */
const makeInvite = async () => {
  const made = await peer.createInvite(f.admin, { agentId: x.agentId });
  return {
    aliceId: made.connection.id,
    inviteToken: made.link.slice(made.link.lastIndexOf("/") + 1),
  };
};

/** Alice invites, Bob joins with Y over the route. Alice's row waits for approval. */
const joinedByBob = async () => {
  const invite = await makeInvite();
  const joined = await peer.joinWithLink(f.bob, {
    agentId: y.agentId,
    link: `${ORIGIN}/connect/${invite.inviteToken}`,
  });
  const bobToken = captured.joins.at(-1);
  if (bobToken === undefined) {
    throw new Error("Bob did not send a token in the join.");
  }
  return {
    aliceId: invite.aliceId,
    bobId: joined.connection.id,
    bobToken,
    checkCode: joined.checkCode,
  };
};

/** A full pairing: join, then Alice approves, which delivers the activation over the route. */
const pairFully = async () => {
  const pending = await joinedByBob();
  await peer.approve(f.admin, pending.aliceId, {
    origin: ORIGIN,
    tokenUrl: null,
  });
  const activation = captured.activations.at(-1);
  if (activation === undefined) {
    throw new Error("Alice did not deliver an activation.");
  }
  return { ...pending, activation };
};

/** A bearer that is not a credential of any row. */
const unknownBearer = () => randomAccessToken();

describe("the pairing join route", () => {
  test("a join without an Authorization header is 401 with the realm challenge", async () => {
    const invite = await makeInvite();
    const res = await pairPost(JOIN_PATH, null, joinBody());
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(WWW_AUTHENTICATE);
    expect(rowOf(invite.aliceId).status).toBe("inviting");
  });

  test("a wrong invite secret is 404 and counts against the invite", async () => {
    const invite = await makeInvite();
    const res = await pairPost(
      JOIN_PATH,
      wrongSecret(invite.inviteToken),
      joinBody()
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: INVALID_INVITE });
    const row = rowOf(invite.aliceId);
    expect(row.inviteFailures).toBe(1);
    expect(row.status).toBe("inviting");
  });

  test("five wrong tries kill the invite, so the right secret fails too", async () => {
    const invite = await makeInvite();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each try must count before the next one
      const res = await pairPost(
        JOIN_PATH,
        wrongSecret(invite.inviteToken),
        joinBody()
      );
      expect(res.status).toBe(404);
    }
    const right = await pairPost(JOIN_PATH, invite.inviteToken, joinBody());
    expect(right.status).toBe(404);
    expect(await right.json()).toEqual({ error: INVALID_INVITE });
    expect(rowOf(invite.aliceId).status).toBe("revoked");
  });

  test("an expired invite is 404", async () => {
    const invite = await makeInvite();
    await f.db
      .update(a2aConnections)
      .set({ inviteExpiresAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(a2aConnections.id, invite.aliceId));
    const res = await pairPost(JOIN_PATH, invite.inviteToken, joinBody());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: INVALID_INVITE });
  });

  test("an invite already used is 404", async () => {
    const invite = await makeInvite();
    const first = await pairPost(JOIN_PATH, invite.inviteToken, joinBody());
    expect(first.status).toBe(200);
    const second = await pairPost(JOIN_PATH, invite.inviteToken, joinBody());
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: INVALID_INVITE });
  });

  test("a body that is not JSON with a wrong invite is 404, because the credential is judged first", async () => {
    const invite = await makeInvite();
    const res = await pairPost(
      JOIN_PATH,
      wrongSecret(invite.inviteToken),
      "not json"
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: INVALID_INVITE });
  });

  test("a body that is not JSON with the right invite is 400, and the invite stays open", async () => {
    const invite = await makeInvite();
    const res = await pairPost(JOIN_PATH, invite.inviteToken, "not json");
    expect(res.status).toBe(400);
    expect(rowOf(invite.aliceId).status).toBe("inviting");
  });
});

describe("the pairing activate route", () => {
  test("a wrong bearer is 404, and no bearer is 401", async () => {
    const pending = await joinedByBob();
    const wrong = await pairPost(
      `/a2a/${y.publicId}/pair/activate`,
      unknownBearer(),
      JSON.stringify({ token: randomAccessToken() })
    );
    expect(wrong.status).toBe(404);
    expect(await wrong.json()).toEqual({ error: NOT_FOUND });

    const none = await pairPost(
      `/a2a/${y.publicId}/pair/activate`,
      null,
      JSON.stringify({ token: randomAccessToken() })
    );
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toBe(WWW_AUTHENTICATE);
    expect(rowOf(pending.bobId).status).toBe("awaiting_peer");
  });

  test("the right bearer under another agent's publicId is 404", async () => {
    const pending = await joinedByBob();
    const res = await pairPost(
      `/a2a/${x.publicId}/pair/activate`,
      pending.bobToken,
      JSON.stringify({ token: randomAccessToken() })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: NOT_FOUND });
    expect(rowOf(pending.bobId).status).toBe("awaiting_peer");
  });

  test("a retry with the same token after success is 200 and changes nothing", async () => {
    const paired = await pairFully();
    const before = rowOf(paired.bobId);
    const res = await pairPost(
      `/a2a/${y.publicId}/pair/activate`,
      paired.bobToken,
      JSON.stringify({ token: paired.activation.token })
    );
    expect(res.status).toBe(200);
    expect(rowOf(paired.bobId)).toEqual(before);
  });

  test("a retry with a different token after success is 409", async () => {
    const paired = await pairFully();
    const res = await pairPost(
      `/a2a/${y.publicId}/pair/activate`,
      paired.bobToken,
      JSON.stringify({ token: randomAccessToken() })
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: NOT_WAITING });
  });
});

describe("the pairing decline route", () => {
  test("Alice declines, the notice marks Bob's row declined and his token stops working", async () => {
    const pending = await joinedByBob();
    await f.composed.services.connections.decline(f.admin, pending.aliceId);

    const notice = await pairPost(
      `/a2a/${y.publicId}/pair/decline`,
      pending.bobToken,
      "{}"
    );
    expect(notice.status).toBe(200);

    const bob = rowOf(pending.bobId);
    expect(bob.status).toBe("declined");
    expect(bob.inboundTokenHash).toBeNull();
    expect(rowOf(pending.aliceId).status).toBe("declined");

    const rpc = await f.rpc(y.publicId, pending.bobToken, "ListTasks");
    expect(rpc.status).toBe(401);
    const again = await pairPost(
      `/a2a/${y.publicId}/pair/activate`,
      pending.bobToken,
      JSON.stringify({ token: randomAccessToken() })
    );
    expect(again.status).toBe(404);
  });
});

describe("the pairing revoke route", () => {
  test("the peer's credential revokes an active pairing, and the token then fails on the agent", async () => {
    const paired = await pairFully();
    const { token } = paired.activation;

    const wrongPath = await pairPost(
      `/a2a/${y.publicId}/pair/revoke`,
      token,
      "{}"
    );
    expect(wrongPath.status).toBe(404);
    expect(rowOf(paired.aliceId).status).toBe("active");

    const revoke = await pairPost(
      `/a2a/${x.publicId}/pair/revoke`,
      token,
      "{}"
    );
    expect(revoke.status).toBe(200);
    expect(rowOf(paired.aliceId).status).toBe("revoked");

    const rpc = await f.rpc(x.publicId, token, "ListTasks");
    expect(rpc.status).toBe(401);
    expect(rpc.headers.get("WWW-Authenticate")).toBe(WWW_AUTHENTICATE);
  });
});

describe("pairing paths refuse anything but a bearer", () => {
  test("a session cookie without a bearer is 401 on the pairing calls", async () => {
    const pending = await joinedByBob();
    const join = await f.app.request(JOIN_PATH, {
      body: joinBody(),
      headers: {
        Cookie: "session=abc",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(join.status).toBe(401);
    expect(rowOf(pending.aliceId).status).toBe("needs_approval");

    const revoke = await f.app.request(`/a2a/${x.publicId}/pair/revoke`, {
      headers: { Cookie: "session=abc", "Content-Type": "application/json" },
      method: "POST",
    });
    expect(revoke.status).toBe(401);
  });

  test("GET on each pairing path is 404", async () => {
    const paths = [
      JOIN_PATH,
      `/a2a/${y.publicId}/pair/activate`,
      `/a2a/${y.publicId}/pair/decline`,
      `/a2a/${x.publicId}/pair/revoke`,
    ];
    for (const path of paths) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time keeps the failure readable
      const res = await f.app.request(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found." });
    }
  });
});

describe("a full pairing through the routes", () => {
  test("join, approve and activate end with both rows active and the new token working on X", async () => {
    const pending = await joinedByBob();
    expect(rowOf(pending.aliceId).status).toBe("needs_approval");
    expect(rowOf(pending.aliceId).checkCode).toBe(pending.checkCode);
    expect(rowOf(pending.bobId).status).toBe("awaiting_peer");

    await peer.approve(f.admin, pending.aliceId, {
      origin: ORIGIN,
      tokenUrl: null,
    });
    const activation = captured.activations.at(-1);
    expect(activation?.bearer).toBe(pending.bobToken);
    expect(activation?.url).toBe(`${ORIGIN}/a2a/${y.publicId}/pair/activate`);
    expect(rowOf(pending.aliceId).status).toBe("active");
    expect(rowOf(pending.bobId).status).toBe("active");

    const rpc = await f.rpc(x.publicId, activation?.token ?? "", "ListTasks");
    expect(rpc.status).toBe(200);
    expect(await rpc.json()).toHaveProperty("result");
  });
});
