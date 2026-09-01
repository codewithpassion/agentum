import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers } from "./handlers";
import { startListenServer } from "./listen";
import { hashToken } from "./token";

const TOKEN = "test-token";

let root = "";
let server: Bun.Server<undefined>;
let origin = "";

const post = (body: unknown, token?: string) =>
  fetch(`${origin}/op`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    method: "POST",
  });

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "computerd-listen-")));
  server = startListenServer({
    handle: createHandlers({ execMaxMs: 5000, root }),
    // Port 0: the OS picks a free one, so the suite never collides with itself.
    port: 0,
    tokenHash: await hashToken(TOKEN),
  });
  origin = `http://localhost:${server.port}`;
});

afterEach(async () => {
  await server.stop(true);
  await rm(root, { force: true, recursive: true });
});

describe("listen mode", () => {
  test("serves /healthz without a token", async () => {
    const response = await fetch(`${origin}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      version: expect.any(String),
    });
  });

  test("rejects a request with no token", async () => {
    const response = await post({ id: "1", op: "ping" });
    expect(response.status).toBe(401);
  });

  test("rejects a request with the wrong token", async () => {
    const response = await post({ id: "1", op: "ping" }, "not-the-token");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      id: "",
      result: { ok: false, reason: "Unauthorized." },
    });
  });

  test("answers an authorized request with the op's result", async () => {
    await writeFile(join(root, "plan.md"), "hello");
    const response = await post(
      { id: "42", op: "read", path: "/plan.md" },
      TOKEN
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "42",
      result: { content: "hello", ok: true, size: 5 },
    });
  });

  test("answers a failing op with 200 and a reason", async () => {
    const response = await post({ id: "7", op: "read", path: "/gone" }, TOKEN);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "7",
      result: { ok: false, reason: "No such file: /gone" },
    });
  });

  test("answers a body that is not JSON with a reason", async () => {
    const response = await fetch(`${origin}/op`, {
      body: "not json",
      headers: { authorization: `Bearer ${TOKEN}` },
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "",
      result: { ok: false, reason: "The request body must be JSON." },
    });
  });

  test("404s an unknown route", async () => {
    const response = await fetch(`${origin}/nope`);
    expect(response.status).toBe(404);
  });
});
