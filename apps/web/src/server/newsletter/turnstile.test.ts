import { describe, expect, spyOn, test } from "bun:test";
import {
  type CheckTurnstileOptions,
  checkTurnstile,
  TURNSTILE_MESSAGES,
  TURNSTILE_TEST_SECRET,
} from "./turnstile";

const PROD = "agentumbot.io";
const LOCAL = ["localhost", "127.0.0.1", "[::1]"];
const UUID_PATTERN = /^[0-9a-f-]{36}$/;
type Reply = { status?: number; body?: unknown } | "network";

function verifier(replies: Reply[]) {
  const bodies: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const fetchImpl = ((_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const r = replies[Math.min(bodies.length - 1, replies.length - 1)];
    if (r === "network" || r === undefined) {
      return Promise.reject(new TypeError("fetch failed"));
    }
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return Promise.resolve(new Response(text, { status: r.status ?? 200 }));
  }) as unknown as typeof fetch;
  const run = (over: Partial<CheckTurnstileOptions> = {}) =>
    checkTurnstile({
      fetch: fetchImpl,
      host: PROD,
      log: (line, level) => (level === "error" ? errors : infos).push(line),
      retryDelayMs: 0,
      secretKey: "0x-real",
      token: "tok",
      ...over,
    });
  return { bodies, errors, infos, run };
}

test("passes a valid token, sending secret, token, remote IP and an idempotency key", async () => {
  const v = verifier([{ body: { success: true } }]);
  expect(await v.run({ remoteIp: "203.0.113.9" })).toEqual({ ok: true });
  expect(v.bodies[0]).toMatchObject({
    remoteip: "203.0.113.9",
    response: "tok",
    secret: "0x-real",
  });
  expect(v.bodies[0]?.idempotency_key).toMatch(UUID_PATTERN);
});

test("refuses a missing token with 400", async () => {
  expect(await verifier([]).run({ token: undefined })).toEqual({
    message: TURNSTILE_MESSAGES.missing_token,
    ok: false,
    reason: "missing_token",
    status: 400,
  });
});

test("refuses a bad token with 400 and logs it at info, not as an incident", async () => {
  const v = verifier([
    { body: { "error-codes": ["timeout-or-duplicate"], success: false } },
  ]);
  expect(await v.run()).toMatchObject({
    ok: false,
    reason: "invalid",
    status: 400,
  });
  expect(v.bodies).toHaveLength(1);
  expect(v.errors).toEqual([]);
  expect(v.infos.map((l) => JSON.parse(l))).toEqual([
    {
      codes: ["timeout-or-duplicate"],
      evt: "turnstile",
      host: PROD,
      outcome: "invalid",
    },
  ]);
});

describe("secret missing", () => {
  test("fails closed on production, with an error log and no siteverify call", async () => {
    const v = verifier([{ body: { success: true } }]);
    expect(await v.run({ secretKey: undefined })).toMatchObject({
      ok: false,
      reason: "not_configured",
      status: 503,
    });
    expect(v.bodies).toHaveLength(0);
    expect(JSON.parse(v.errors[0] ?? "null")).toMatchObject({
      evt: "turnstile",
      host: PROD,
      outcome: "not_configured",
    });
  });
  test.each(LOCAL)("is skipped on the local dev host %s", async (host) => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await verifier([]).run({ host, secretKey: undefined })).toEqual({
      ok: true,
    });
    warn.mockRestore();
  });
  test.each([
    "example.com",
    "localhost.example.com",
    "agentum-v2.workers.dev",
    "100.91.97.17",
  ])("fails closed on %s", async (host) => {
    expect(await verifier([]).run({ host, secretKey: "" })).toMatchObject({
      ok: false,
      reason: "not_configured",
    });
  });
});

describe("the always-passing test secret", () => {
  test.each(LOCAL)(
    "passes without calling siteverify on the local dev host %s",
    async (host) => {
      const v = verifier([]);
      expect(await v.run({ host, secretKey: TURNSTILE_TEST_SECRET })).toEqual({
        ok: true,
      });
      expect(v.bodies).toHaveLength(0);
    }
  );
  test.each([
    PROD,
    "www.agentumbot.io",
    "agentum-v2.workers.dev",
    "localhost.evil.com",
  ])("is refused on %s", async (host) => {
    const v = verifier([]);
    expect(
      await v.run({ host, secretKey: TURNSTILE_TEST_SECRET })
    ).toMatchObject({ ok: false, reason: "not_configured", status: 503 });
    expect(v.bodies).toHaveLength(0);
    expect(v.errors[0]).toContain("test secret outside local dev");
  });
});

describe("siteverify unavailable", () => {
  test("retries once with the same idempotency key and passes when the retry works", async () => {
    const v = verifier(["network", { body: { success: true } }]);
    expect(await v.run()).toEqual({ ok: true });
    expect(v.bodies).toHaveLength(2);
    expect(v.bodies[1]?.idempotency_key).toBe(v.bodies[0]?.idempotency_key);
    expect(v.errors).toEqual([]);
  });
  test("after two failures answers 503 'try again in a minute' and logs both errors", async () => {
    const v = verifier([
      "network",
      { body: "<html>bad gateway</html>", status: 502 },
    ]);
    expect(await v.run()).toEqual({
      message: TURNSTILE_MESSAGES.unavailable,
      ok: false,
      reason: "unavailable",
      status: 503,
    });
    expect(JSON.parse(v.errors[0] ?? "null")).toMatchObject({
      attempts: 2,
      error: "HTTP 502, no JSON verdict",
      evt: "turnstile",
      firstError: "TypeError: fetch failed",
      outcome: "unavailable",
    });
  });
  test("treats internal-error as unavailable", async () => {
    const v = verifier([
      { body: { "error-codes": ["internal-error"], success: false } },
    ]);
    expect(await v.run()).toMatchObject({ reason: "unavailable" });
    expect(v.bodies).toHaveLength(2);
  });
  test("a timeout is unavailable", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason)
        )
      )) as unknown as typeof fetch;
    expect(
      await checkTurnstile({
        fetch: hang,
        host: PROD,
        log: () => undefined,
        retryDelayMs: 0,
        secretKey: "s",
        timeoutMs: 10,
        token: "t",
      })
    ).toMatchObject({ reason: "unavailable" });
  });
});

test("a rejected secret is our config, not the visitor's fault", async () => {
  const v = verifier([
    { body: { "error-codes": ["invalid-input-secret"], success: false } },
  ]);
  expect(await v.run()).toMatchObject({
    ok: false,
    reason: "not_configured",
    status: 503,
  });
  expect(v.errors[0]).toContain("siteverify rejected the secret or request");
});

test("bad-request (a malformed siteverify call) is ours too: 503 and an error log", async () => {
  const v = verifier([
    { body: { "error-codes": ["bad-request"], success: false }, status: 400 },
  ]);
  expect(await v.run()).toEqual({
    message: TURNSTILE_MESSAGES.not_configured,
    ok: false,
    reason: "not_configured",
    status: 503,
  });
  expect(v.bodies).toHaveLength(1);
  expect(JSON.parse(v.errors[0] ?? "null")).toMatchObject({
    codes: ["bad-request"],
    evt: "turnstile",
    outcome: "not_configured",
  });
  expect(v.infos).toEqual([]);
});
