import { beforeEach, describe, expect, test } from "bun:test";
import { type Task, taskSchema } from "@repo/a2a/tasks";
import {
  a2aConnections,
  a2aPairingRequests,
  a2aTasks,
} from "@repo/db/schema/a2a";
import { events } from "@repo/db/schema/events";
import { Hono } from "hono";
import {
  type A2aFixture,
  createA2aFixture,
  type Published,
  textMessage,
} from "./a2a-fixture.ts";
import type { AppEnv } from "./groups.ts";
import { mcpRoutes } from "./mcp.ts";

const TOKEN_LENGTH = 40;
const SHORT_TOKEN_LENGTH = 31;
const CODE_PATTERN = /Pairing code: ([A-Z2-9]{8})/;
const CODE_SHAPE = /^[A-Z2-9]{8}$/;
const SECRET_TEXT = "PAIRING-SECRET-TEXT-9d3f";
const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);
const MCP_ENV = {
  PUBLIC_BASE_URL: "https://hm.test",
  RUN_TOKEN_KEY,
} as unknown as Env;

/** A bearer the client made up: `length` random hex characters. */
const madeUpToken = (length: number): string => {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
};

const sha256Hex = async (text: string): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

let f: A2aFixture;
let agent: Published;

beforeEach(async () => {
  f = await createA2aFixture();
  agent = await f.publish("echo");
});

const pairingRows = () => f.db.select().from(a2aPairingRequests).all();
const connectionRows = () => f.db.select().from(a2aConnections).all();
const taskRows = () => f.db.select().from(a2aTasks).all();
const eventRows = () => f.db.select().from(events).all();

const setPairing = (open: boolean) =>
  f.composed.services.connections.setPairingOpen(f.admin, {
    agentId: agent.agentId,
    open,
  });

const approve = (code: string) =>
  f.composed.services.connections.approvePairingCode(f.admin, {
    agentId: agent.agentId,
    code,
    label: "Hermes",
  });

const sendRpc = (token: string, text = "hi") =>
  f.rpc(agent.publicId, token, "SendMessage", textMessage("m1", text));

const sendRest = (token: string, text = "hi") =>
  f.rest(
    agent.publicId,
    token,
    "POST",
    "/message:send",
    textMessage("m1", text)
  );

const taskOfRpc = async (res: Response): Promise<Task> => {
  const body = (await res.json()) as { result: { task: unknown } };
  return taskSchema.parse(body.result.task);
};

const taskOfRest = async (res: Response): Promise<Task> => {
  const body = (await res.json()) as { task: unknown };
  return taskSchema.parse(body.task);
};

const codeOf = (task: Task): string => {
  const match = CODE_PATTERN.exec(task.status.message?.parts[0]?.text ?? "");
  if (match?.[1] === undefined) {
    throw new Error("The task carries no pairing code.");
  }
  return match[1];
};

/** Asks with an unknown token over JSON-RPC and returns the code the client got. */
const codeFor = async (token: string): Promise<string> => {
  const res = await sendRpc(token);
  if (res.status !== 200) {
    throw new Error(`The agent answered ${res.status}, not a pairing code.`);
  }
  return codeOf(await taskOfRpc(res));
};

describe("with pairing off, the default", () => {
  test("an unknown 40-character token gets 401 on SendMessage over JSON-RPC and REST, and no request is stored", async () => {
    const token = madeUpToken(TOKEN_LENGTH);
    expect((await sendRpc(token)).status).toBe(401);
    expect((await sendRest(token)).status).toBe(401);
    expect(pairingRows()).toHaveLength(0);
  });
});

describe("with pairing on", () => {
  beforeEach(async () => {
    await setPairing(true);
  });

  test("a 31-character token gets 401 on both bindings, and no request is stored", async () => {
    const token = madeUpToken(SHORT_TOKEN_LENGTH);
    expect((await sendRpc(token)).status).toBe(401);
    expect((await sendRest(token)).status).toBe(401);
    expect(pairingRows()).toHaveLength(0);
  });

  test("a 40-character token gets a rejected task with an 8-character code on both bindings, and no task is stored", async () => {
    const token = madeUpToken(TOKEN_LENGTH);

    const rpc = await sendRpc(token);
    expect(rpc.status).toBe(200);
    const rpcTask = await taskOfRpc(rpc);
    expect(rpcTask.status.state).toBe("TASK_STATE_REJECTED");
    expect(codeOf(rpcTask)).toMatch(CODE_SHAPE);

    const rest = await sendRest(token);
    expect(rest.status).toBe(200);
    const restTask = await taskOfRest(rest);
    expect(restTask.status.state).toBe("TASK_STATE_REJECTED");
    expect(codeOf(restTask)).toMatch(CODE_SHAPE);

    expect(taskRows()).toHaveLength(0);
  });

  test("the same token gets the same code and one request row, and another token gets another code", async () => {
    const token = madeUpToken(TOKEN_LENGTH);
    const first = await codeFor(token);
    const second = await codeFor(token);
    expect(second).toBe(first);
    expect(pairingRows()).toHaveLength(1);

    const other = await codeFor(madeUpToken(TOKEN_LENGTH));
    expect(other).not.toBe(first);
    expect(pairingRows()).toHaveLength(2);
  });

  test("a fourth pending token is refused with 401, and the first three still work", async () => {
    const tokens = [
      madeUpToken(TOKEN_LENGTH),
      madeUpToken(TOKEN_LENGTH),
      madeUpToken(TOKEN_LENGTH),
    ];
    const codes: string[] = [];
    for (const token of tokens) {
      // biome-ignore lint/performance/noAwaitInLoops: each request must be stored before the next one
      codes.push(await codeFor(token));
    }
    expect(pairingRows()).toHaveLength(3);

    const fourth = await sendRpc(madeUpToken(TOKEN_LENGTH));
    expect(fourth.status).toBe(401);
    expect(pairingRows()).toHaveLength(3);

    const again: string[] = [];
    for (const token of tokens) {
      // biome-ignore lint/performance/noAwaitInLoops: one request at a time keeps the failure readable
      again.push(await codeFor(token));
    }
    expect(again).toEqual(codes);
  });

  test("every other operation with an unknown 40-character token is 401, and no request is stored", async () => {
    const token = madeUpToken(TOKEN_LENGTH);
    const calls = [
      () => f.rpc(agent.publicId, token, "GetTask", { id: "abc" }),
      () => f.rpc(agent.publicId, token, "ListTasks"),
      () =>
        f.rpc(
          agent.publicId,
          token,
          "SendStreamingMessage",
          textMessage("m1", "hi")
        ),
      () => f.rest(agent.publicId, token, "GET", "/tasks"),
      () =>
        f.rest(
          agent.publicId,
          token,
          "POST",
          "/message:stream",
          textMessage("m1", "hi")
        ),
      () => f.rest(agent.publicId, token, "GET", "/tasks/abc"),
    ];
    const results = await Promise.all(calls.map((call) => call()));
    expect(results.map((res) => res.status)).toEqual([
      401, 401, 401, 401, 401, 401,
    ]);
    expect(pairingRows()).toHaveLength(0);
  });

  test("a request code approved from a 40-character token lets that token send on the same path, and the code cannot be used twice", async () => {
    const token = madeUpToken(TOKEN_LENGTH);
    const code = await codeFor(token);
    await approve(code);

    const res = await sendRpc(token);
    expect(res.status).toBe(200);
    expect((await taskOfRpc(res)).status.state).toBe(
      "TASK_STATE_AUTH_REQUIRED"
    );

    await expect(approve(code)).rejects.toThrow();
  });

  test("a token that already belongs to a connection is never paired again, and an unknown token on another agent is 401", async () => {
    const connected = await f.connect(agent);
    const res = await f.rpc(
      agent.publicId,
      connected.token,
      "SendMessage",
      textMessage("m1", "hi")
    );
    expect(res.status).toBe(200);
    expect((await taskOfRpc(res)).status.state).toBe("TASK_STATE_COMPLETED");
    expect(pairingRows()).toHaveLength(0);

    const other = await f.publish("agent-two");
    const elsewhere = await f.rpc(
      other.publicId,
      madeUpToken(TOKEN_LENGTH),
      "SendMessage",
      textMessage("m1", "hi")
    );
    expect(elsewhere.status).toBe(401);
    expect(pairingRows()).toHaveLength(0);
  });

  test("the message text, the code and the raw token are stored nowhere, and the token's hash is", async () => {
    const token = madeUpToken(TOKEN_LENGTH);
    const hash = await sha256Hex(token);
    const res = await sendRpc(token, SECRET_TEXT);
    const code = codeOf(await taskOfRpc(res));

    expect(pairingRows().map((row) => row.tokenHash)).toEqual([hash]);

    await approve(code);
    expect(connectionRows().map((row) => row.inboundTokenHash)).toContain(hash);

    const stored = JSON.stringify({
      connections: connectionRows(),
      events: eventRows(),
      pairing: pairingRows(),
      tasks: taskRows(),
    });
    expect(stored).not.toContain(SECRET_TEXT);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(token);
    expect(stored).toContain(hash);
  });

  test("the token still gets 401 on /mcp after it is paired", async () => {
    const token = madeUpToken(TOKEN_LENGTH);
    await approve(await codeFor(token));

    // The `/mcp` route as the app mounts it, over the same services.
    const mcp = new Hono<AppEnv>();
    mcp.use("*", async (c, next) => {
      c.set("composed", f.composed);
      await next();
    });
    mcp.route(
      "/mcp",
      mcpRoutes({
        clientName: () => () => Promise.resolve(null),
        dev: false,
        isOrgMember: () => () => Promise.resolve(true),
        userOrgIds: () => () => Promise.resolve([]),
        verifyOAuthToken: () => () => Promise.resolve(null),
      })
    );
    const res = await mcp.request(
      "https://hm.test/mcp",
      {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Host: "hm.test",
        },
        method: "POST",
      },
      MCP_ENV
    );
    expect(res.status).toBe(401);

    // The same token is accepted on its agent's A2A path, so the 401 is the MCP refusal.
    const a2a = await f.rpc(agent.publicId, token, "ListTasks");
    expect(a2a.status).toBe(200);
  });
});
