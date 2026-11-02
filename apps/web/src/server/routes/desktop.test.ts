import { afterEach, beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import {
  type MachineRelayPort,
  noopRelay,
} from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { Hono } from "hono";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { LEASE_REQUIRED_MESSAGE } from "../desktop-failure.ts";
import {
  RELAY_HEADER_MACHINE_ID,
  RELAY_HEADER_ROLE,
  RELAY_HEADER_VIEWER_USER,
  RELAY_HEADER_WORKSPACE_ID,
} from "../relay-core.ts";
import { desktopRoutes } from "./desktop.ts";
import type { AppEnv } from "./groups.ts";

const ORG_IDS = ["org_a", "org_b"];
const ORIGIN = "http://localhost";
const UPGRADE = { Upgrade: "websocket", Origin: ORIGIN };

class FakeWebSocketPair {
  readonly 0 = { accept: () => undefined, close: () => undefined };
  readonly 1 = { accept: () => undefined, close: () => undefined };
}

const workerGlobals = globalThis as unknown as { WebSocketPair?: unknown };
const originalPair = workerGlobals.WebSocketPair;

beforeEach(() => {
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
let session: { orgId?: string | null; userId: string | null } | null;

const user = () => ({
  kind: "user" as const,
  userId: "user_1",
  via: "session" as const,
  workspaceId,
});

const infra = (relay: MachineRelayPort): Infra => {
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
    relay,
  };
};

/** Builds the services over the same database, with the given relay stub. */
const useRelay = (relay: MachineRelayPort) => {
  composed = composeWith({
    db,
    infra: infra(relay),
  });
};

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("composed", composed);
  await next();
});
app.route(
  "/api/machines/:id/desktop",
  desktopRoutes({ session: () => session })
);

beforeEach(async () => {
  db = migrated(ORG_IDS);
  useRelay(noopRelay);
  session = { orgId: "org_a", userId: "user_1" };
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("org_a has no workspace row");
  }
  workspaceId = workspace.id;
  relayRequests.length = 0;
  relayIds.length = 0;
});

const enrolCode = async (
  principal: ReturnType<typeof user>,
  machineName: string,
  role: "agent_host" | "computer" = "agent_host"
) => {
  const { code } = await composed.services.machines.createEnrollToken(
    principal,
    { machineName, role }
  );
  return code;
};

/** A daemon machine, which has no computer role. */
const daemonMachine = async (): Promise<string> => {
  const code = await enrolCode(user(), "laptop");
  const enrolled = await composed.services.machines.enroll({
    code,
    singleUser: false,
  });
  if (!enrolled) {
    throw new Error("daemon enrol failed");
  }
  return enrolled.machineId;
};

/** A machine with the computer role, enrolled through a computer code. */
const computerMachine = async (
  principal: ReturnType<typeof user> = user()
): Promise<string> => {
  const code = await enrolCode(principal, "box", "computer");
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
  return enrolled.machineId;
};

const statusUrl = (id: string) => `http://localhost/api/machines/${id}/desktop`;
const clipboardUrl = (id: string) => `${statusUrl(id)}/clipboard`;
const streamUrl = (id: string) => `${statusUrl(id)}/stream`;

const getStatus = (id: string, headers: Record<string, string> = {}) =>
  app.request(statusUrl(id), { headers, method: "GET" }, env);
const getClipboard = (id: string) =>
  app.request(clipboardUrl(id), { method: "GET" }, env);
const putClipboard = (
  id: string,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  app.request(
    clipboardUrl(id),
    {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
      method: "PUT",
    },
    env
  );
const getStream = (id: string, headers: Record<string, string> = {}) =>
  app.request(streamUrl(id), { headers, method: "GET" }, env);

const statusesOf = (requests: (() => Response | Promise<Response>)[]) =>
  Promise.all(requests.map(async (request) => (await request()).status));

/** Every route of the group, as a request for one machine. */
const allRoutes = (id: string) => [
  () => getStatus(id),
  () => getClipboard(id),
  () => putClipboard(id, { text: "x" }),
  () => getStream(id, UPGRADE),
];

const connectedRelay = (
  holder: string | null,
  overrides: Partial<MachineRelayPort> = {}
): MachineRelayPort => ({
  ...noopRelay,
  computerStatus: () =>
    Promise.resolve({
      capabilities: {
        desktop: true,
        desktop_unavailable_reason: null,
        git: true,
      } as never,
      connected: true,
      control:
        holder === null
          ? null
          : {
              expiresAt: Date.now() + 60_000,
              holder: { kind: "human", userId: holder },
            },
      hostname: "box",
      inFlightExec: 0,
      lastSeenAt: Date.now(),
      queued: 0,
      version: "1.0.0",
      workdir: "/work",
    }),
  ...overrides,
});

test("no signed-in user answers 401 on every route", async () => {
  session = { userId: null };
  const id = await computerMachine();

  expect(await statusesOf(allRoutes(id))).toEqual([401, 401, 401, 401]);
  const body = await (await getStatus(id)).json();
  expect(body).toEqual({ error: "unauthorized" });
});

test("a signed-in user with no workspace answers 403", async () => {
  session = { orgId: "org_unknown", userId: "user_1" };
  const id = await computerMachine();

  expect(await statusesOf(allRoutes(id))).toEqual([403, 403, 403, 403]);
  expect(await (await getStatus(id)).json()).toEqual({
    error: "no_workspace",
  });
});

test("a machine another workspace owns is a 404 on every route", async () => {
  const other = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_b",
  });
  if (!other) {
    throw new Error("org_b has no workspace row");
  }
  const otherUser = {
    kind: "user" as const,
    userId: "user_2",
    via: "session" as const,
    workspaceId: other.id,
  };
  const id = await computerMachine(otherUser);

  expect(await statusesOf(allRoutes(id))).toEqual([404, 404, 404, 404]);
});

test("a revoked computer machine is a 404 on every route", async () => {
  const id = await computerMachine();
  await composed.services.machines.revoke(user(), id);

  expect(await statusesOf(allRoutes(id))).toEqual([404, 404, 404, 404]);
});

test("a machine without the computer role is a 404 on every route", async () => {
  const id = await daemonMachine();

  expect(await statusesOf(allRoutes(id))).toEqual([404, 404, 404, 404]);
});

test("status reports a connected computer, and youHaveControl only for the caller", async () => {
  const id = await computerMachine();
  useRelay(connectedRelay("user_1"));
  const mine = await getStatus(id);
  expect(mine.status).toBe(200);
  expect(await mine.json()).toEqual({
    connected: true,
    control: expect.objectContaining({
      holder: { kind: "human", userId: "user_1" },
    }),
    desktop: true,
    desktopUnavailableReason: null,
    youHaveControl: true,
  });

  useRelay(connectedRelay("user_2"));
  const theirs = await (await getStatus(id)).json();
  expect(theirs).toMatchObject({ connected: true, youHaveControl: false });
});

test("clipboard read returns the text and is never cached", async () => {
  const id = await computerMachine();
  let asked: unknown = null;
  useRelay(
    connectedRelay(null, {
      clipboardGet: (machineId, principal) => {
        asked = { machineId, principal };
        return Promise.resolve({
          ok: true,
          resultJson: JSON.stringify({ text: "copied" }),
        });
      },
    })
  );

  const res = await getClipboard(id);

  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.json()).toEqual({ text: "copied" });
  expect(asked).toEqual({
    machineId: id,
    principal: { kind: "human", userId: "user_1" },
  });
});

test("an unreadable clipboard reply answers 502 desktop_failed", async () => {
  const id = await computerMachine();
  useRelay(
    connectedRelay(null, {
      clipboardGet: () => Promise.resolve({ ok: true, resultJson: "not json" }),
    })
  );

  const res = await getClipboard(id);

  expect(res.status).toBe(502);
  expect((await res.json()) as { error: string }).toMatchObject({
    error: "desktop_failed",
  });
});

test("a clipboard read refused for a missing lease answers 423 lease_required", async () => {
  const id = await computerMachine();
  useRelay(
    connectedRelay(null, {
      clipboardGet: () =>
        Promise.resolve({
          code: null,
          message: "not yours",
          ok: false,
          reason: "forbidden",
        }),
    })
  );

  const res = await getClipboard(id);

  expect(res.status).toBe(423);
  expect(await res.json()).toEqual({
    error: "lease_required",
    message: LEASE_REQUIRED_MESSAGE,
  });
});

test("clipboard write sends the text as the caller and answers 204", async () => {
  const id = await computerMachine();
  let sent: unknown = null;
  useRelay(
    connectedRelay(null, {
      clipboardSet: (machineId, principal, input) => {
        sent = { machineId, principal, input };
        return Promise.resolve({ ok: true, resultJson: "{}" });
      },
    })
  );

  const res = await putClipboard(id, { text: "paste me" });

  expect(res.status).toBe(204);
  expect(sent).toEqual({
    machineId: id,
    principal: { kind: "human", userId: "user_1" },
    input: { selections: ["clipboard", "primary"], text: "paste me" },
  });
});

test("clipboard write refused for a missing lease answers 423 lease_required", async () => {
  const id = await computerMachine();
  useRelay(
    connectedRelay(null, {
      clipboardSet: () =>
        Promise.resolve({
          code: null,
          message: "not yours",
          ok: false,
          reason: "forbidden",
        }),
    })
  );

  const res = await putClipboard(id, { text: "x" });

  expect(res.status).toBe(423);
  expect(await res.json()).toEqual({
    error: "lease_required",
    message: LEASE_REQUIRED_MESSAGE,
  });
});

test("clipboard write with a body that is not { text } answers 400 bad_request", async () => {
  const id = await computerMachine();

  const replies = await Promise.all(
    ["not json", { text: 1 }, {}].map((body) => putClipboard(id, body))
  );
  expect(replies.map((reply) => reply.status)).toEqual([400, 400, 400]);
  expect(await Promise.all(replies.map((reply) => reply.json()))).toEqual([
    { error: "bad_request", message: expect.any(String) },
    { error: "bad_request", message: expect.any(String) },
    { error: "bad_request", message: expect.any(String) },
  ]);
});

test("a cross-site form PUT to the clipboard is refused by csrf", async () => {
  const id = await computerMachine();
  useRelay(
    connectedRelay(null, {
      clipboardSet: () => Promise.resolve({ ok: true, resultJson: "{}" }),
    })
  );

  const res = await app.request(
    clipboardUrl(id),
    {
      body: "text=evil",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Origin: "https://evil.example",
      },
      method: "PUT",
    },
    env
  );

  expect(res.status).toBe(403);
});

test("the stream without an Upgrade header answers 426", async () => {
  const id = await computerMachine();

  const res = await getStream(id, { Origin: ORIGIN });

  expect(res.status).toBe(426);
  expect(await res.json()).toEqual({
    error: "upgrade_required",
    message: "Expected a WebSocket upgrade.",
  });
});

test("the stream without an Origin, or with a foreign one, answers 403", async () => {
  const id = await computerMachine();

  expect((await getStream(id, { Upgrade: "websocket" })).status).toBe(403);
  const foreign = await getStream(id, {
    Upgrade: "websocket",
    Origin: "https://evil.example",
  });
  expect(foreign.status).toBe(403);
  expect(await foreign.json()).toEqual({
    error: "forbidden",
    message: "Cross-origin request refused.",
  });
  expect(relayRequests).toHaveLength(0);
});

test("the stream hands the upgrade to the relay as the signed-in viewer", async () => {
  const id = await computerMachine();

  const res = await getStream(id, {
    ...UPGRADE,
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
    Authorization: "Bearer hm_mach_secret",
    [RELAY_HEADER_VIEWER_USER]: "someone_else",
    [RELAY_HEADER_ROLE]: "daemon",
    "x-hm-machine-id": "other",
  });

  expect(res.status).toBe(200);
  expect(relayIds).toEqual([id]);
  expect(relayRequests).toHaveLength(1);
  const [forwarded] = relayRequests;
  expect(forwarded?.headers.get(RELAY_HEADER_VIEWER_USER)).toBe("user_1");
  expect(forwarded?.headers.get(RELAY_HEADER_ROLE)).toBe("viewer");
  expect(forwarded?.headers.get(RELAY_HEADER_MACHINE_ID)).toBe(id);
  expect(forwarded?.headers.get(RELAY_HEADER_WORKSPACE_ID)).toBe(workspaceId);
  expect(forwarded?.headers.get("authorization")).toBeNull();
  expect(forwarded?.headers.get("upgrade")).toBe("websocket");
  expect(forwarded?.headers.get("sec-websocket-key")).toBe(
    "dGhlIHNhbXBsZSBub25jZQ=="
  );
});
