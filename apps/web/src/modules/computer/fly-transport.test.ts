import { beforeEach, describe, expect, test } from "bun:test";
import {
  createFlyTransport,
  FLY_TIMEOUT_GRACE_MS,
  flyRequestTimeoutMs,
} from "./fly-transport";
import {
  ComputerTransportError,
  REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
} from "./remote-client";
import type { ComputerHost } from "./schema";

/**
 * The Fly transport: one POST to the app's `/op`, the daemon token on it, and
 * the machine pinned with `fly-force-instance-id` so the proxy wakes *this*
 * agent's machine rather than any of them.
 *
 * Nothing here reaches a network - the `fetch` is injected - and nothing here
 * has ever been checked against a real Fly proxy.
 */

const TOKEN = "daemon-token";
const ECONNREFUSED = /ECONNREFUSED/;
const NOT_JSON = /not JSON/;

const host = (config: ComputerHost["config"] = { app: "agentum-computers" }) =>
  ({
    config,
    id: "host-1",
    kind: "fly",
    name: "fly-eu",
  }) as ComputerHost;

interface Call {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  method: string;
  signal: AbortSignal | undefined;
  url: string;
}

let calls: Call[] = [];

const answering = (
  handler: (call: Call) => Promise<Response> | Response
): typeof fetch =>
  ((url: string, init: RequestInit) => {
    const call: Call = {
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
      method: String(init.method),
      signal: init.signal ?? undefined,
      url: String(url),
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as unknown as typeof fetch;

const env = {} as Env;

const lastCall = (): Call => calls.at(-1) as Call;

beforeEach(() => {
  calls = [];
});

const echoing = answering((call) =>
  Response.json({ id: call.body.id, result: { ok: true } })
);

describe("the request", () => {
  test("posts the message to the app's /op with the daemon token", async () => {
    const transport = createFlyTransport(env, {
      fetchImpl: echoing,
      host: host(),
      machineId: "m-1",
      token: TOKEN,
    });

    const reply = await transport.send({ id: "call-1", op: "ping" });

    expect(reply).toEqual({ id: "call-1", result: { ok: true } });
    expect(lastCall().url).toBe("https://agentum-computers.fly.dev/op");
    expect(lastCall().method).toBe("POST");
    expect(lastCall().headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(lastCall().headers["content-type"]).toBe("application/json");
    expect(lastCall().body).toEqual({ id: "call-1", op: "ping" });
  });

  test("pins the agent's machine so the proxy wakes that one", async () => {
    const transport = createFlyTransport(env, {
      fetchImpl: echoing,
      host: host(),
      machineId: "m-1",
      token: TOKEN,
    });

    await transport.send({ id: "call-1", op: "ping" });

    expect(lastCall().headers["fly-force-instance-id"]).toBe("m-1");
  });

  test("a host-level ping pins nothing, so any machine may answer", async () => {
    const transport = createFlyTransport(env, {
      fetchImpl: echoing,
      host: host(),
      machineId: null,
      token: TOKEN,
    });

    await transport.send({ id: "call-1", op: "ping" });

    expect(lastCall().headers["fly-force-instance-id"]).toBeUndefined();
  });

  test("a host with no Fly app says so instead of building a nonsense URL", async () => {
    const transport = createFlyTransport(env, {
      fetchImpl: echoing,
      host: host({}),
      machineId: "m-1",
      token: TOKEN,
    });

    await expect(transport.send({ id: "call-1", op: "ping" })).rejects.toThrow(
      ComputerTransportError
    );
    expect(calls).toEqual([]);
  });
});

describe("the deadline", () => {
  test("a command's own timeout, plus room for a cold start", () => {
    expect(flyRequestTimeoutMs({ op: "exec", timeoutMs: 300_000 })).toBe(
      300_000 + FLY_TIMEOUT_GRACE_MS
    );
  });

  test("a message with no timeout gets the daemon's default", () => {
    expect(flyRequestTimeoutMs({ op: "ping" })).toBe(
      REMOTE_EXEC_DEFAULT_TIMEOUT_MS + FLY_TIMEOUT_GRACE_MS
    );
  });

  test("a timeout beyond the cap is capped, not honoured", () => {
    expect(flyRequestTimeoutMs({ op: "exec", timeoutMs: 60 * 60_000 })).toBe(
      REMOTE_EXEC_MAX_TIMEOUT_MS + FLY_TIMEOUT_GRACE_MS
    );
  });

  test("nonsense in the message does not become a zero-length wait", () => {
    expect(flyRequestTimeoutMs({ op: "exec", timeoutMs: -1 })).toBe(
      REMOTE_EXEC_DEFAULT_TIMEOUT_MS + FLY_TIMEOUT_GRACE_MS
    );
  });

  test("the request carries a signal, so nothing waits forever", async () => {
    const transport = createFlyTransport(env, {
      fetchImpl: echoing,
      host: host(),
      machineId: "m-1",
      token: TOKEN,
    });

    await transport.send({ id: "call-1", op: "ping" });

    expect(lastCall().signal).toBeInstanceOf(AbortSignal);
    expect(lastCall().signal?.aborted).toBe(false);
  });
});

describe("what the agent is told when it fails", () => {
  const failingWith = (status: number) =>
    createFlyTransport(env, {
      fetchImpl: answering(() => new Response("nope", { status })),
      host: host(),
      machineId: "m-1",
      token: TOKEN,
    });

  /** The refusal a status produces, or "" if the transport wrongly accepted it. */
  const reasonOf = async (status: number): Promise<string> => {
    try {
      await failingWith(status).send({ id: "call-1", op: "ping" });
      return "";
    } catch (error) {
      return error instanceof ComputerTransportError ? error.message : "";
    }
  };

  test("a 502 reads as a machine that is probably still starting", async () => {
    const reason = await reasonOf(502);

    expect(reason).toContain("not responding (HTTP 502)");
    expect(reason).toContain("try again in a few seconds");
  });

  test("a 401 points at the host's token, which is the fix", async () => {
    expect(await reasonOf(401)).toContain("Rotate the computer host's token");
  });

  test("a 404 says the machine is gone rather than starting", async () => {
    expect(await reasonOf(404)).toContain("could not be found");
  });

  test("a connection that never came up is not a stack trace", async () => {
    const transport = createFlyTransport(env, {
      fetchImpl: (() =>
        Promise.reject(
          new TypeError("fetch failed: ECONNREFUSED")
        )) as unknown as typeof fetch,
      host: host(),
      machineId: "m-1",
      token: TOKEN,
    });

    const failure = transport.send({ id: "call-1", op: "ping" });

    await expect(failure).rejects.toThrow(ComputerTransportError);
    await expect(failure).rejects.not.toThrow(ECONNREFUSED);
  });

  test("an answer that is not JSON is refused, not parsed into nothing", async () => {
    const transport = createFlyTransport(env, {
      fetchImpl: answering(() => new Response("<html>fly proxy</html>")),
      host: host(),
      machineId: "m-1",
      token: TOKEN,
    });

    await expect(transport.send({ id: "call-1", op: "ping" })).rejects.toThrow(
      NOT_JSON
    );
  });
});
