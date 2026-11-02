import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import {
  claimResponseSchema,
  createRequestResponseSchema,
  DAEMON_FEATURES_HEADER,
  FEATURE_REQUESTS,
  waitRequestResponseSchema,
} from "@repo/protocol/machine";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { importRunTokenKey } from "@repo/services/run-tokens";
import type { Clock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { Hono } from "hono";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import type { AppEnv } from "./groups.ts";
import { machineRoutes } from "./machines.ts";

const ORG = "org_a";
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const RUN_ROUTES = "/api/machines/runs";
const TOOL_USE = "toolu_1";
const SECOND = 1000;
const OK = 200;
const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const UNAUTHORIZED = 401;
const CONFLICT = 409;
const NINE_KB = 9000;
const PREVIEW_CHARS = 1300;

const APPROVAL = {
  display: {
    input: { command: "ls" },
    summary: "Run ls",
    toolKey: "bash",
    toolName: "bash",
  },
  kind: "approval",
  toolName: "bash",
  toolUseId: TOOL_USE,
};

let db: ReturnType<typeof migrated>;
let composed: Composed;
let nowMs: number;
let user: Extract<Principal, { kind: "user" }>;

/** A test clock whose sleep moves it on, so a long poll ends without real waiting. */
const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: (ms) => {
    nowMs += ms;
    return Promise.resolve();
  },
};

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
    clock,
    devFakeRuntime: false,
    fileBlobs: memoryFileBlobs(),
    relay: noopRelay,
    runTokenKey: KEY,
  };
};

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("composed", composed);
  await next();
});
app.route("/api/machines", machineRoutes());

beforeEach(async () => {
  db = migrated([ORG]);
  nowMs = Date.now();
  await importRunTokenKey(KEY);
  composed = composeWith({ db, infra: infra() });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: ORG,
  });
  if (!workspace) {
    throw new Error("workspace missing");
  }
  user = {
    kind: "user",
    userId: "user_1",
    via: "session",
    workspaceId: workspace.id,
  };
});

const enrol = async (name: string) => {
  const { code } = await composed.services.machines.createEnrollToken(user, {
    machineName: name,
  });
  const enrolled = await composed.services.machines.enroll({
    code,
    singleUser: false,
  });
  if (!enrolled) {
    throw new Error("enrol failed");
  }
  return enrolled;
};

/** A machine with a claimed, running run. */
const runningRun = async (name = "laptop") => {
  const { credential, machineId } = await enrol(name);
  const agent = await composed.services.agents.create(user, {
    machineId,
    model: "m",
    name: `${name}-box`,
    runtime: "machine",
  });
  nowMs += SECOND;
  const started = await composed.services.runs.startRun(user, {
    agentId: agent.id,
    input: { text: "hi" },
    session: { origin: "ui" },
  });
  const claimed = await app.request(`${RUN_ROUTES}/${started.runId}/claim`, {
    body: "{}",
    headers: {
      Authorization: `Bearer ${credential}`,
      [DAEMON_FEATURES_HEADER]: FEATURE_REQUESTS,
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (claimed.status !== OK) {
    throw new Error(`claim answered ${claimed.status}`);
  }
  return { credential, runId: started.runId };
};

const create = (
  runId: string,
  credential: string | null,
  body: unknown = APPROVAL
) =>
  app.request(`${RUN_ROUTES}/${runId}/requests`, {
    body: JSON.stringify(body),
    headers: {
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      "content-type": "application/json",
    },
    method: "POST",
  });

const wait = (
  runId: string,
  requestId: string,
  credential: string,
  seconds?: number
) =>
  app.request(
    `${RUN_ROUTES}/${runId}/requests/${requestId}${
      seconds === undefined ? "" : `?wait=${seconds}`
    }`,
    { headers: { Authorization: `Bearer ${credential}` } }
  );

const DONE = {
  status: "done",
  text: "hi",
  usage: { inputTokens: 1, outputTokens: 2 },
};

const complete = (runId: string, credential: string) =>
  app.request(`${RUN_ROUTES}/${runId}/complete`, {
    body: JSON.stringify(DONE),
    headers: {
      Authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

const opened = async (runId: string, credential: string) =>
  createRequestResponseSchema.parse(
    await (await create(runId, credential)).json()
  );

test("create opens a pending request, and a repeat create returns the same id", async () => {
  const { credential, runId } = await runningRun();

  const first = await opened(runId, credential);
  const again = await opened(runId, credential);

  expect(first.status).toBe("pending");
  expect(first.outcome).toBeUndefined();
  expect(again.requestId).toBe(first.requestId);
});

test("a 9 KB tool input, sent as the daemon's text preview, opens a redacted request", async () => {
  const { credential, runId } = await runningRun();
  const token = "sk-ant-api03-AbCdEf1234567890xyz";
  const json = JSON.stringify({
    command: `curl -H "x-api-key: ${token}" ${"x".repeat(NINE_KB)}`,
  });
  const preview = `${json.slice(0, PREVIEW_CHARS)}… [truncated]`;

  const response = await create(runId, credential, {
    ...APPROVAL,
    display: { ...APPROVAL.display, input: preview },
  });

  expect(response.status).toBe(OK);
  expect(createRequestResponseSchema.parse(await response.json()).status).toBe(
    "pending"
  );
  const [stored] = await composed.services.requests.listPending(user);
  const input = JSON.stringify(stored?.display);
  expect(input).toContain("[truncated]");
  expect(input).not.toContain(token);
});

test("a question request opens too", async () => {
  const { credential, runId } = await runningRun();

  const response = await create(runId, credential, {
    display: { questions: [{ question: "Which database?" }] },
    kind: "question",
    toolName: "ask",
    toolUseId: "toolu_q",
  });

  expect(response.status).toBe(OK);
  expect(createRequestResponseSchema.parse(await response.json()).status).toBe(
    "pending"
  );
});

test("a display that does not match its kind is refused with 400", async () => {
  const { credential, runId } = await runningRun();

  const response = await create(runId, credential, {
    ...APPROVAL,
    kind: "question",
  });

  expect(response.status).toBe(BAD_REQUEST);
});

test("a body that fails the schema is refused with 400", async () => {
  const { credential, runId } = await runningRun();

  expect((await create(runId, credential, { kind: "approval" })).status).toBe(
    BAD_REQUEST
  );
});

test("wait answers pending when the time runs out", async () => {
  const { credential, runId } = await runningRun();
  const { requestId } = await opened(runId, credential);

  const response = await wait(runId, requestId, credential, 5);

  expect(response.status).toBe(OK);
  expect(waitRequestResponseSchema.parse(await response.json())).toEqual({
    status: "pending",
  });
});

test("wait returns the outcome once a user answered", async () => {
  const { credential, runId } = await runningRun();
  const { requestId } = await opened(runId, credential);
  await composed.services.requests.answer(user, {
    answer: { decision: "allow_once" },
    requestId,
    via: "web",
  });

  const response = await wait(runId, requestId, credential, 5);

  expect(waitRequestResponseSchema.parse(await response.json())).toEqual({
    outcome: { answer: { decision: "allow_once" }, status: "answered" },
    status: "answered",
  });
});

test("wait without a wait query answers at once and caps a long wait at 25 s", async () => {
  const { credential, runId } = await runningRun();
  const { requestId } = await opened(runId, credential);

  const started = nowMs;
  await wait(runId, requestId, credential);
  expect(nowMs).toBe(started);

  await wait(runId, requestId, credential, 600);
  expect(nowMs - started).toBe(25 * SECOND);
});

test("another machine's credential is refused", async () => {
  const { credential, runId } = await runningRun();
  const { requestId } = await opened(runId, credential);
  const other = await enrol("desktop");

  expect((await create(runId, other.credential)).status).toBe(FORBIDDEN);
  expect((await wait(runId, requestId, other.credential)).status).toBe(
    FORBIDDEN
  );
});

test("no credential is refused with 401", async () => {
  const { runId } = await runningRun();

  expect((await create(runId, null)).status).toBe(UNAUTHORIZED);
});

test("a finished run is refused with 409", async () => {
  const { credential, runId } = await runningRun();
  expect((await complete(runId, credential)).status).toBe(OK);

  expect((await create(runId, credential)).status).toBe(CONFLICT);
});

test("the claim carries the ask tool keys only for a daemon that names requests", async () => {
  const { credential, machineId } = await enrol("laptop");
  const agent = await composed.services.agents.create(user, {
    machineId,
    model: "m",
    name: "Box",
    runtime: "machine",
  });
  const claim = async (features: Record<string, string>) => {
    nowMs += SECOND;
    const started = await composed.services.runs.startRun(user, {
      agentId: agent.id,
      input: { text: "hi" },
      session: { origin: "ui" },
    });
    const response = await app.request(`${RUN_ROUTES}/${started.runId}/claim`, {
      body: "{}",
      headers: {
        Authorization: `Bearer ${credential}`,
        ...features,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const json = (await response.json()) as Record<string, unknown>;
    // Release the agent so its next run can be claimed.
    await complete(started.runId, credential);
    return json;
  };

  const modern = await claim({ [DAEMON_FEATURES_HEADER]: FEATURE_REQUESTS });
  const old = await claim({});

  expect(claimResponseSchema.safeParse(modern).success).toBe(true);
  expect(modern).toHaveProperty("toolRules");
  expect(old).not.toHaveProperty("toolRules");
});
