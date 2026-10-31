import { beforeEach, describe, expect, test } from "bun:test";
import type { A2aFetch } from "@repo/a2a/peer-fetch";
import { a2aConnections, a2aOutbox } from "@repo/db/schema/a2a";
import { events } from "@repo/db/schema/events";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { encryptSecret, importSecretsKey } from "../crypto.ts";
import {
  createOutboxService,
  OUTBOX_BACKOFF_MS,
  OUTBOX_BATCH,
  OUTBOX_MAX_ATTEMPTS,
} from "./outbox.ts";
import {
  CONNECTION,
  createFixture,
  type Fixture,
  member,
  SECRETS_KEY,
  START,
  WORKSPACE,
} from "./tasks-fixture.ts";

type OutboxKind = (typeof a2aOutbox.$inferInsert)["kind"];

let f: Fixture;

beforeEach(async () => {
  f = await createFixture();
});

const iso = (ms: number) => new Date(ms).toISOString();

/** A fake peer that answers `status`. */
const fakePeer = (status = 200) => {
  const calls: { init: RequestInit; url: string }[] = [];
  const fetch: A2aFetch = (url, init) => {
    calls.push({ init, url });
    return Promise.resolve(new Response(null, { status }));
  };
  return { calls, fetch };
};

const service = (peer: { fetch: A2aFetch }) =>
  createOutboxService({
    activation: {
      activationAbandoned: f.connections.activationAbandoned,
      activationDelivered: f.connections.activationDelivered,
    },
    clock: f.clock,
    db: f.db,
    events: f.events,
    fetch: peer.fetch,
    secretsKey: SECRETS_KEY,
  });

const sealed = async (rowId: string, field: string, plaintext: string) =>
  await encryptSecret(
    await importSecretsKey(SECRETS_KEY),
    { field, rowId, table: "a2a_outbox", workspaceId: WORKSPACE },
    plaintext
  );

/** An outbox row, its headers sealed the way the services seal them. */
const queue = async (row: {
  attempts?: number;
  body?: string;
  connectionId?: string;
  headers?: Record<string, string> | null;
  id: string;
  kind: OutboxKind;
  nextAttemptAt?: string;
  url?: string;
}) => {
  const headers =
    row.headers === null
      ? null
      : await sealed(
          row.id,
          "headers",
          JSON.stringify(row.headers ?? { Authorization: "Bearer peer-secret" })
        );
  await f.db.insert(a2aOutbox).values({
    attempts: row.attempts ?? 0,
    body: row.body ?? '{"task":{"id":"t1"}}',
    connectionId: row.connectionId ?? CONNECTION,
    createdAt: START,
    headers,
    id: row.id,
    kind: row.kind,
    nextAttemptAt: row.nextAttemptAt ?? START,
    url: row.url ?? "https://peer.test/hook",
    workspaceId: WORKSPACE,
  });
};

/** A `pair_activate` row, its token sealed under `body.token`. */
const queueActivation = async (id: string, token = "token-plain") => {
  await queue({
    body: JSON.stringify({ token: await sealed(id, "body.token", token) }),
    id,
    kind: "pair_activate",
    url: "https://peer.test/pair/activate",
  });
};

const rows = async () => await f.db.select().from(a2aOutbox);

const droppedEvents = async () =>
  await f.db.select().from(events).where(eq(events.type, "a2a.outbox_dropped"));

describe("deliverDue", () => {
  test("a due push row is POSTed with its unsealed headers and body, then deleted", async () => {
    await f.connect();
    await queue({ body: '{"task":{"id":"t1"}}', id: "obx_1", kind: "push" });
    const peer = fakePeer();

    const tally = await service(peer).deliverDue(f.system);

    expect(tally).toEqual({ delivered: 1, dropped: 0, retried: 0, skipped: 0 });
    expect(peer.calls).toHaveLength(1);
    const [call] = peer.calls;
    expect(call?.url).toBe("https://peer.test/hook");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe('{"task":{"id":"t1"}}');
    expect(call?.init.headers).toEqual({
      "A2A-Version": "1.0",
      Authorization: "Bearer peer-secret",
      "Content-Type": "application/json",
    });
    expect(await rows()).toHaveLength(0);
  });

  test("a row that is not yet due is left alone", async () => {
    await f.connect();
    await queue({
      id: "obx_1",
      kind: "push",
      nextAttemptAt: iso(Date.parse(START) + 60_000),
    });
    const peer = fakePeer();

    const tally = await service(peer).deliverDue(f.system);

    expect(tally.delivered).toBe(0);
    expect(peer.calls).toHaveLength(0);
    expect(await rows()).toHaveLength(1);
  });

  test("a failing row backs off through the delays and is not sent before it is due", async () => {
    await f.connect();
    await queue({ id: "obx_1", kind: "push" });
    const peer = fakePeer(500);
    const outbox = service(peer);

    for (const [index, delay] of OUTBOX_BACKOFF_MS.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: each tick depends on the clock and row the one before left
      await outbox.deliverDue(f.system);
      expect(peer.calls).toHaveLength(index + 1);
      const [row] = await rows();
      expect(row?.attempts).toBe(index + 1);
      expect(row?.nextAttemptAt).toBe(iso(f.clock.now().getTime() + delay));

      f.advance(delay - 1);
      await outbox.deliverDue(f.system);
      expect(peer.calls).toHaveLength(index + 1);
      f.advance(1);
    }
  });

  test("the 8th failed attempt drops the row with one exhausted event that names no url or header", async () => {
    await f.connect();
    await queue({ id: "obx_1", kind: "push" });
    const peer = fakePeer(500);
    const outbox = service(peer);

    for (const delay of OUTBOX_BACKOFF_MS) {
      // biome-ignore lint/performance/noAwaitInLoops: each attempt moves the clock past the row's backoff before the next
      await outbox.deliverDue(f.system);
      f.advance(delay);
    }
    const tally = await outbox.deliverDue(f.system);

    expect(peer.calls).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    expect(tally.dropped).toBe(1);
    expect(await rows()).toHaveLength(0);
    const dropped = await droppedEvents();
    expect(dropped).toHaveLength(1);
    const [event] = dropped;
    expect(JSON.parse(event?.payload ?? "{}")).toEqual({
      attempts: OUTBOX_MAX_ATTEMPTS,
      connectionId: CONNECTION,
      kind: "push",
      reason: "exhausted",
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain("peer.test");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("peer-secret");
  });

  test("a push row for a revoked connection is skipped without a call", async () => {
    await f.connect({ status: "revoked" });
    await queue({ id: "obx_1", kind: "push" });
    const peer = fakePeer();

    const tally = await service(peer).deliverDue(f.system);

    expect(tally.skipped).toBe(1);
    expect(peer.calls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  test("a pair_activate row for a connection that is activating is delivered with the token and marks it active", async () => {
    await f.connect({ status: "activating" });
    await queueActivation("obx_1", "token-plain");
    const peer = fakePeer();

    const tally = await service(peer).deliverDue(f.system);

    expect(tally.delivered).toBe(1);
    const [call] = peer.calls;
    expect(JSON.parse(String(call?.init.body))).toEqual({
      token: "token-plain",
    });
    expect(await rows()).toHaveLength(0);
    const [connection] = await f.db
      .select({ status: a2aConnections.status })
      .from(a2aConnections)
      .where(eq(a2aConnections.id, CONNECTION));
    expect(connection?.status).toBe("active");
  });

  test("a pair_activate row for a connection that is no longer activating is skipped", async () => {
    await f.connect({ status: "revoked" });
    await queueActivation("obx_1");
    const peer = fakePeer();

    const tally = await service(peer).deliverDue(f.system);

    expect(tally.skipped).toBe(1);
    expect(peer.calls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  test("a pair_activate answered 404 is dropped at once and abandons the activation", async () => {
    await f.connect({ status: "activating" });
    await queueActivation("obx_1");
    const peer = fakePeer(404);
    const abandoned: string[] = [];
    const outbox = createOutboxService({
      activation: {
        activationAbandoned: async (p, id) => {
          abandoned.push(id);
          await f.connections.activationAbandoned(p, id);
        },
        activationDelivered: f.connections.activationDelivered,
      },
      clock: f.clock,
      db: f.db,
      events: f.events,
      fetch: peer.fetch,
      secretsKey: SECRETS_KEY,
    });

    const tally = await outbox.deliverDue(f.system);

    expect(tally.dropped).toBe(1);
    expect(peer.calls).toHaveLength(1);
    expect(abandoned).toEqual([CONNECTION]);
    expect(await rows()).toHaveLength(0);
    const [event] = await droppedEvents();
    expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({
      reason: "status 404",
    });
  });

  test("pair_revoke and pair_decline rows are delivered although the connection is revoked", async () => {
    await f.connect({ status: "revoked" });
    await queue({ body: "{}", id: "obx_1", kind: "pair_revoke" });
    await queue({ body: "{}", id: "obx_2", kind: "pair_decline" });
    const peer = fakePeer();

    const tally = await service(peer).deliverDue(f.system);

    expect(tally).toEqual({ delivered: 2, dropped: 0, retried: 0, skipped: 0 });
    expect(peer.calls).toHaveLength(2);
    expect(await rows()).toHaveLength(0);
  });

  test("a thrown fetch counts as a failed attempt and the next row is still delivered", async () => {
    await f.connect();
    await queue({ id: "obx_a", kind: "push", url: "https://peer.test/down" });
    await queue({ id: "obx_b", kind: "push" });
    const peer = fakePeer();
    const fetch: A2aFetch = (url, init) =>
      url.endsWith("/down")
        ? Promise.reject(new Error("connection reset"))
        : peer.fetch(url, init);

    const tally = await service({ fetch }).deliverDue(f.system);

    expect(tally).toEqual({ delivered: 1, dropped: 0, retried: 1, skipped: 0 });
    expect(peer.calls).toHaveLength(1);
    const remaining = await rows();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe("obx_a");
    expect(remaining[0]?.attempts).toBe(1);
  });

  test("two overlapping ticks deliver a row once", async () => {
    await f.connect();
    await queue({ id: "obx_1", kind: "push" });
    const peer = fakePeer();
    const outbox = service(peer);

    const [first, second] = await Promise.all([
      outbox.deliverDue(f.system),
      outbox.deliverDue(f.system),
    ]);

    expect(peer.calls).toHaveLength(1);
    expect(first.delivered + second.delivered).toBe(1);
    expect(await rows()).toHaveLength(0);
  });

  test("a principal other than the system is refused", async () => {
    await f.connect();
    await queue({ id: "obx_1", kind: "push" });
    const peer = fakePeer();

    await expect(service(peer).deliverDue(member())).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(peer.calls).toHaveLength(0);
  });

  test("one tick takes at most OUTBOX_BATCH rows", async () => {
    await f.connect();
    const total = OUTBOX_BATCH + 5;
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        queue({ id: `obx_${String(i).padStart(3, "0")}`, kind: "push" })
      )
    );
    const peer = fakePeer();

    const tally = await service(peer).deliverDue(f.system);

    expect(tally.delivered).toBe(OUTBOX_BATCH);
    expect(peer.calls).toHaveLength(OUTBOX_BATCH);
    expect(await rows()).toHaveLength(total - OUTBOX_BATCH);
  });
});
