import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs } from "@repo/db/schema/runs";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Composed, composeWith } from "../compose.ts";
import type { AppEnv } from "./groups.ts";
import { triggerRoutes } from "./triggers.ts";

const ROUTE = "/api/triggers";
const MAX_BODY_BYTES = 512 * 1024;

let db: ReturnType<typeof migrated>;
let composed: Composed;
let workspaceId: string;
let app: Hono<AppEnv>;
let echoAgentId: string;

const sessionUser = (userId: string): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});

const user = () => sessionUser("u1");

/** A trigger on the echo agent, with the token it was created with. */
const makeTrigger = async (agentId = echoAgentId, name = "hook") => {
  const created = await composed.services.triggers.create(user(), {
    agentId,
    name,
  });
  return { secret: created.secret, triggerId: created.trigger.id };
};

const fire = (
  id: string,
  body: string,
  token: string | null = null,
  headers: Record<string, string> = {}
) =>
  app.request(`${ROUTE}/${id}`, {
    body,
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    method: "POST",
  });

const runRow = (runId: string) =>
  db.select().from(runs).where(eq(runs.id, runId)).get();

/** The `trigger.fired` events of a run. */
const firedEvents = (runId: string) =>
  composed.services.events.query(user(), workspaceId, {
    runId,
    types: ["trigger.fired"],
  });

beforeEach(async () => {
  db = migrated(["org_a"]);
  const store = new Map<string, string>();
  composed = composeWith({
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
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("org_a has no workspace row");
  }
  workspaceId = workspace.id;
  echoAgentId = (
    await composed.services.agents.create(user(), {
      model: "fake",
      name: "Echo",
      runtime: "fake",
      slug: "echo",
    })
  ).id;
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("composed", composed);
    await next();
  });
  app.route(ROUTE, triggerRoutes());
});

describe("POST /api/triggers/:id", () => {
  test("waitMs makes the call wait and answer 200 with the result", async () => {
    const { secret, triggerId } = await makeTrigger();

    const res = await fire(
      triggerId,
      JSON.stringify({ text: "ping", waitMs: 5000 }),
      secret
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      error: null,
      result: "Echo: ping",
      status: "done",
    });
  });

  test("without waitMs the call answers 202 with the run", async () => {
    const { secret, triggerId } = await makeTrigger();

    const res = await fire(triggerId, JSON.stringify({ text: "ping" }), secret);

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      runId: string;
      sessionId: string;
      status: string;
    };
    expect(body.runId).toBeString();
    expect(body.sessionId).toBeString();
  });

  test("a run that does not finish in time answers 202", async () => {
    const machine = await composed.services.machines.createEnrollToken(user(), {
      machineName: "laptop",
    });
    const enrolled = await composed.services.machines.enroll({
      code: machine.code,
      singleUser: false,
    });
    if (!enrolled) {
      throw new Error("enrol failed");
    }
    const agentId = (
      await composed.services.agents.create(user(), {
        machineId: enrolled.machineId,
        model: "m",
        name: "Machine",
        runtime: "machine",
        slug: "machine",
      })
    ).id;
    const { secret, triggerId } = await makeTrigger(agentId, "slow");

    const res = await fire(
      triggerId,
      JSON.stringify({ text: "ping", waitMs: 50 }),
      secret
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("offered");
  });

  test("the same requestId twice gives the same run", async () => {
    const { secret, triggerId } = await makeTrigger();
    const body = JSON.stringify({ requestId: "req-1", text: "ping" });

    const first = (await (await fire(triggerId, body, secret)).json()) as {
      runId: string;
    };
    const second = (await (await fire(triggerId, body, secret)).json()) as {
      runId: string;
    };

    expect(second.runId).toBe(first.runId);
  });

  test("a replayed request records one trigger.fired event", async () => {
    const { secret, triggerId } = await makeTrigger();
    const body = JSON.stringify({ requestId: "req-2", text: "ping" });

    const first = (await (await fire(triggerId, body, secret)).json()) as {
      runId: string;
    };
    await fire(triggerId, body, secret);

    expect(await firedEvents(first.runId)).toHaveLength(1);
  });

  test("the run is on behalf of nobody", async () => {
    const { secret, triggerId } = await makeTrigger();

    const res = await fire(triggerId, JSON.stringify({ text: "ping" }), secret);
    const { runId } = (await res.json()) as { runId: string };

    expect(runRow(runId)?.onBehalfOfUserId).toBeNull();
  });

  test("a revoked token answers 401", async () => {
    const { secret, triggerId } = await makeTrigger();
    await composed.services.triggers.revoke(user(), triggerId);

    const res = await fire(triggerId, JSON.stringify({ text: "ping" }), secret);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid trigger token." });
  });

  test("a missing or malformed Authorization header answers 401 with a challenge", async () => {
    const { triggerId } = await makeTrigger();
    const body = JSON.stringify({ text: "ping" });

    const missing = await fire(triggerId, body);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="harbourmaster"'
    );

    const malformed = await fire(triggerId, body, null, {
      Authorization: "Basic hm_trg_abc",
    });
    expect(malformed.status).toBe(401);
  });

  test("an hm_key_ or random token answers 401", async () => {
    const { triggerId } = await makeTrigger();
    const body = JSON.stringify({ text: "ping" });

    expect((await fire(triggerId, body, "hm_key_abc123")).status).toBe(401);
    expect((await fire(triggerId, body, "not-a-token")).status).toBe(401);
  });

  test("a token for trigger A on trigger B's id answers 403", async () => {
    const a = await makeTrigger(echoAgentId, "a");
    const b = await makeTrigger(echoAgentId, "b");

    const res = await fire(
      b.triggerId,
      JSON.stringify({ text: "ping" }),
      a.secret
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Not allowed." });
  });

  test("invalid JSON answers 400", async () => {
    const { secret, triggerId } = await makeTrigger();

    const res = await fire(triggerId, "not json", secret);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "The body must be JSON." });
  });

  test("an empty text answers 400 and names the field", async () => {
    const { secret, triggerId } = await makeTrigger();

    const res = await fire(triggerId, JSON.stringify({ text: "" }), secret);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.startsWith("text: ")).toBe(true);
  });

  test("a waitMs over the limit answers 400", async () => {
    const { secret, triggerId } = await makeTrigger();

    const res = await fire(
      triggerId,
      JSON.stringify({ text: "ping", waitMs: 999_999 }),
      secret
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.startsWith("waitMs: ")).toBe(true);
  });

  test("a body over 512 KB answers 413", async () => {
    const { secret, triggerId } = await makeTrigger();
    const text = "a".repeat(MAX_BODY_BYTES);

    const res = await fire(triggerId, JSON.stringify({ text }), secret);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body too large" });
  });

  test("only POST is routed", async () => {
    const { secret, triggerId } = await makeTrigger();

    const res = await app.request(`${ROUTE}/${triggerId}`, {
      headers: { Authorization: `Bearer ${secret}` },
      method: "GET",
    });

    expect(res.status).toBe(404);
  });
});
