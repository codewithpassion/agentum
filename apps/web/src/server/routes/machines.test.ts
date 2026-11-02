import { afterEach, beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { enrollResponseSchema } from "@repo/protocol/machine";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { Hono } from "hono";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import {
  RELAY_HEADER_MACHINE_ID,
  RELAY_HEADER_ROLE,
  RELAY_HEADER_WORKSPACE_ID,
} from "../relay-core.ts";
import type { AppEnv } from "./groups.ts";
import { machineRoutes } from "./machines.ts";

const ORG_IDS = ["org_a"];
const CONNECT = "http://localhost/api/machines/connect";
const COMPUTER = "http://localhost/api/machines/computer";

class RecordingSocket {
  accepted = false;
  closed: { code: number; reason: string } | null = null;

  accept() {
    this.accepted = true;
  }

  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
}

/** Stands in for the Workers global. `[0]` goes to the client, `[1]` is the server end. */
class FakeWebSocketPair {
  readonly 0 = new RecordingSocket();
  readonly 1 = new RecordingSocket();
  static created: FakeWebSocketPair[] = [];

  constructor() {
    FakeWebSocketPair.created.push(this);
  }
}

const workerGlobals = globalThis as unknown as { WebSocketPair?: unknown };
const originalPair = workerGlobals.WebSocketPair;

beforeEach(() => {
  FakeWebSocketPair.created = [];
  workerGlobals.WebSocketPair = FakeWebSocketPair;
});

afterEach(() => {
  workerGlobals.WebSocketPair = originalPair;
});

const relayRequests: Request[] = [];
const relayIds: string[] = [];
const relayStub = {
  fetch: (request: Request) => {
    relayRequests.push(request);
    return Promise.resolve(new Response(null, { status: 200 }));
  },
};
const relayNamespace = {
  get: (id: string) => {
    relayIds.push(id);
    return relayStub;
  },
  idFromName: (name: string) => name,
};
const env = { MACHINE_RELAY: relayNamespace } as unknown as Env;

let db: ReturnType<typeof migrated>;
let composed: Composed;
let workspaceId: string;
const user = () => ({
  kind: "user" as const,
  userId: "user_1",
  via: "session" as const,
  workspaceId,
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
  };
};

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("composed", composed);
  await next();
});
app.route("/api/machines", machineRoutes());

beforeEach(async () => {
  db = migrated(ORG_IDS);
  composed = composeWith({
    db,
    infra: infra(),
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("org_a is not an allowed organisation");
  }
  workspaceId = workspace.id;
  relayRequests.length = 0;
  relayIds.length = 0;
});

const mintCode = async (machineName = "laptop") =>
  (await composed.services.machines.createEnrollToken(user(), { machineName }))
    .code;

const enrol = async () => {
  const code = await mintCode();
  const enrolled = await composed.services.machines.enroll({
    code,
    singleUser: false,
  });
  if (!enrolled) {
    throw new Error("enrol failed");
  }
  return enrolled;
};

const postEnroll = (body: unknown) =>
  app.request(
    "/api/machines/enroll",
    {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    env
  );

const connect = (headers: Record<string, string> = {}) =>
  app.request(CONNECT, { headers, method: "GET" }, env);

const computerSocket = (headers: Record<string, string> = {}) =>
  app.request(COMPUTER, { headers, method: "GET" }, env);

/** A computer-only machine, enrolled through a computer code. */
const enrolComputer = async () => {
  const { code } = await composed.services.machines.createEnrollToken(user(), {
    machineName: "box",
    role: "computer",
  });
  const enrolled = await composed.services.machines.enroll({
    arch: "arm64",
    clientVersion: "1.2.3",
    code,
    hostname: "box",
    os: "linux",
    role: "computer",
  });
  if (!enrolled) {
    throw new Error("computer enrol failed");
  }
  return enrolled;
};

const upgrade = { Upgrade: "websocket" };

/** The server end of the most recent pair, which is what the route closes on refusal. */
const lastServerSocket = () => {
  const pair = FakeWebSocketPair.created.at(-1);
  if (!pair) {
    throw new Error("no socket pair was created");
  }
  return pair[1];
};

test("enrol trades a code for a machine and a credential", async () => {
  const code = await mintCode();

  const res = await postEnroll({ code, singleUser: false });

  expect(res.status).toBe(200);
  const body = enrollResponseSchema.parse(await res.json());
  expect(body.credential.startsWith("hm_mach_")).toBe(true);
  expect(body.machineId).toBeTruthy();
});

test("the same enrol code a second time answers 401", async () => {
  const code = await mintCode();
  expect((await postEnroll({ code, singleUser: false })).status).toBe(200);

  const res = await postEnroll({ code, singleUser: false });

  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({
    error: "The enrolment code is invalid, expired or already used.",
  });
});

test("an unknown enrol code answers 401", async () => {
  const res = await postEnroll({ code: "hm_enr_unknown", singleUser: false });

  expect(res.status).toBe(401);
});

test("a malformed enrol body answers 400", async () => {
  expect((await postEnroll("not json")).status).toBe(400);
  expect((await postEnroll({ code: "hm_enr_x" })).status).toBe(400);
  expect((await postEnroll({ code: "wrong", singleUser: false })).status).toBe(
    400
  );
});

test("connect without an Upgrade header answers 426", async () => {
  const res = await connect({});

  expect(res.status).toBe(426);
  expect(await res.json()).toEqual({ error: "Expected a WebSocket upgrade." });
});

test("connect with no credential accepts the upgrade and closes it with 4401", async () => {
  const res = await connect(upgrade);

  expect(res.status).toBe(101);
  expect(lastServerSocket().accepted).toBe(true);
  expect(lastServerSocket().closed).toEqual({
    code: 4401,
    reason: "credential rejected",
  });
  expect(relayRequests).toHaveLength(0);
});

test("connect with an unknown credential closes with 4401 and never reaches the relay", async () => {
  const res = await connect({
    ...upgrade,
    Authorization: "Bearer hm_mach_nope",
  });

  expect(res.status).toBe(101);
  expect(lastServerSocket().closed?.code).toBe(4401);
  expect(relayRequests).toHaveLength(0);
});

test("connect with a revoked machine's credential closes with 4401 and never reaches the relay", async () => {
  const { credential, machineId } = await enrol();
  await composed.services.machines.revoke(user(), machineId);

  const res = await connect({
    ...upgrade,
    Authorization: `Bearer ${credential}`,
  });

  expect(res.status).toBe(101);
  expect(lastServerSocket().closed?.code).toBe(4401);
  expect(relayRequests).toHaveLength(0);
});

test("connect with the good credential forwards to the relay with the machine's identity", async () => {
  const { credential, machineId } = await enrol();

  const res = await connect({
    ...upgrade,
    Authorization: `Bearer ${credential}`,
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
    "x-hm-machine-id": "spoofed",
    "x-hm-workspace-id": "spoofed",
  });

  expect(res.status).toBe(200);
  expect(relayIds).toEqual([machineId]);
  expect(relayRequests).toHaveLength(1);
  const [forwarded] = relayRequests;
  expect(forwarded?.headers.get(RELAY_HEADER_MACHINE_ID)).toBe(machineId);
  expect(forwarded?.headers.get(RELAY_HEADER_WORKSPACE_ID)).toBe(workspaceId);
  expect(forwarded?.headers.get("authorization")).toBeNull();
  expect(forwarded?.headers.get("upgrade")).toBe("websocket");
  expect(forwarded?.headers.get("sec-websocket-key")).toBe(
    "dGhlIHNhbXBsZSBub25jZQ=="
  );
  expect(forwarded?.headers.get(RELAY_HEADER_ROLE)).toBe("daemon");
});

test("connect ignores a client-sent role header and forwards role daemon", async () => {
  const { credential } = await enrol();

  const res = await connect({
    ...upgrade,
    Authorization: `Bearer ${credential}`,
    [RELAY_HEADER_ROLE]: "computer",
  });

  expect(res.status).toBe(200);
  expect(relayRequests[0]?.headers.get(RELAY_HEADER_ROLE)).toBe("daemon");
});

test("computer without an Upgrade header answers 426", async () => {
  const res = await computerSocket({});

  expect(res.status).toBe(426);
  expect(await res.json()).toEqual({ error: "Expected a WebSocket upgrade." });
});

test("computer with a computer credential forwards to the relay with role computer", async () => {
  const { credential, machineId } = await enrolComputer();

  const res = await computerSocket({
    ...upgrade,
    Authorization: `Bearer ${credential}`,
    [RELAY_HEADER_ROLE]: "daemon",
  });

  expect(res.status).toBe(200);
  expect(relayIds).toEqual([machineId]);
  expect(relayRequests).toHaveLength(1);
  const [forwarded] = relayRequests;
  expect(forwarded?.headers.get(RELAY_HEADER_MACHINE_ID)).toBe(machineId);
  expect(forwarded?.headers.get(RELAY_HEADER_WORKSPACE_ID)).toBe(workspaceId);
  expect(forwarded?.headers.get(RELAY_HEADER_ROLE)).toBe("computer");
  expect(forwarded?.headers.get("authorization")).toBeNull();
});

test("computer with a daemon credential closes with 4401 and never reaches the relay", async () => {
  const { credential } = await enrol();

  const res = await computerSocket({
    ...upgrade,
    Authorization: `Bearer ${credential}`,
  });

  expect(res.status).toBe(101);
  expect(lastServerSocket().closed?.code).toBe(4401);
  expect(relayRequests).toHaveLength(0);
});

test("connect with a computer credential closes with 4401 and never reaches the relay", async () => {
  const { credential } = await enrolComputer();

  const res = await connect({
    ...upgrade,
    Authorization: `Bearer ${credential}`,
  });

  expect(res.status).toBe(101);
  expect(lastServerSocket().closed?.code).toBe(4401);
  expect(relayRequests).toHaveLength(0);
});

test("enrol accepts a computer body and returns a credential and machine id", async () => {
  const { code } = await composed.services.machines.createEnrollToken(user(), {
    machineName: "box",
    role: "computer",
  });

  const res = await postEnroll({
    arch: "arm64",
    clientVersion: "1.2.3",
    code,
    hostname: "box",
    os: "linux",
    role: "computer",
  });

  expect(res.status).toBe(200);
  const body = enrollResponseSchema.parse(await res.json());
  expect(body.credential.startsWith("hm_mach_")).toBe(true);
  expect(body.machineId).toBeTruthy();
});

test("a computer body with a daemon enrol code answers 401", async () => {
  const code = await mintCode();

  const res = await postEnroll({
    arch: "arm64",
    clientVersion: "1.2.3",
    code,
    hostname: "box",
    os: "linux",
    role: "computer",
  });

  expect(res.status).toBe(401);
});
