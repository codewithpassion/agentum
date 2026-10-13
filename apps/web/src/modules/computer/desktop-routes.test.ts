import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import type { DesktopRelayPort } from "./desktop-routes";
import type { RelayOutcome, RelayStatus } from "./relay";

/**
 * The person-facing desktop routes: who may call them, what a refused desktop
 * op answers with, and the one rule that keeps a cookie session from being used
 * by another site (the Origin check). The relay is a fake; its lease rules are
 * tested in relay.test.ts.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

let signedInAs: string | null = "user-1";
mock.module("@clerk/hono", () => ({
  getAuth: () => (signedInAs ? { userId: signedInAs } : null),
}));

const { createDesktopRoutes } = await import("./desktop-routes");
const { onHandBack } = await import("./takeover-hook");
type HandBackEvent = Parameters<typeof onHandBack>[0];

const APP_ORIGIN = "https://app.example.com";
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const JPEG_B64 = btoa(String.fromCharCode(...JPEG_BYTES));

interface Recorded {
  message: Record<string, unknown>;
  principal: unknown;
}

let requests: Recorded[] = [];
let takes: string[] = [];
let releases: string[] = [];
let hands: HandBackEvent[] = [];
let connected = true;
let control: RelayStatus["control"] = null;
let failWith: RelayOutcome | null = null;
let takeOutcome: Awaited<ReturnType<DesktopRelayPort["takeHumanLease"]>>;
let releaseOutcome: Awaited<ReturnType<DesktopRelayPort["releaseHumanLease"]>>;

/** A refusal or failure as the relay returns it. */
function failed(
  reason: Exclude<
    Awaited<ReturnType<DesktopRelayPort["request"]>>["reason"],
    null
  >,
  code: string | null = null
) {
  return {
    code,
    message: `refused: ${reason}`,
    ok: false as const,
    reason,
    result_json: null,
  };
}

const resultFor = (op: unknown): string => {
  switch (op) {
    case "desktop_screenshot":
      return JSON.stringify({
        data_b64: JPEG_B64,
        height: 800,
        media_type: "image/jpeg",
        width: 1280,
      });
    case "desktop_clipboard_get":
      return JSON.stringify({ text: "copied" });
    default:
      return JSON.stringify({ ok: true });
  }
};

const fakeRelay: DesktopRelayPort = {
  releaseHumanLease: (userId) => {
    releases.push(userId);
    return Promise.resolve(releaseOutcome);
  },
  request: (message, principal) => {
    requests.push({ message, principal });
    if (failWith) {
      return Promise.resolve(failWith);
    }
    return Promise.resolve({
      code: null,
      message: "",
      ok: true,
      reason: null,
      result_json: resultFor(message.op),
    });
  },
  status: () =>
    Promise.resolve({
      capabilities: {
        desktop: true,
        desktop_unavailable_reason: null,
        git: true,
        python3: true,
        skills: false,
      },
      connected,
      control,
      hostname: "office-box",
      version: "1.2.3",
      workdir: "/var/lib/agentum-computer/sessions",
    }),
  takeHumanLease: (userId) => {
    takes.push(userId);
    return Promise.resolve(takeOutcome);
  },
};

const app = new Hono<ApiEnv>();
app.use("*", async (c, next) => {
  c.set("workspace", {
    id: "ws-1",
  } as unknown as ApiEnv["Variables"]["workspace"]);
  await next();
});
app.route(
  "/agents",
  createDesktopRoutes({
    findAgentHost: (_env, _workspaceId, agentId) =>
      Promise.resolve(agentId === "a-none" ? undefined : { id: "host-1" }),
    onHandBack: (event) => {
      hands.push(event);
      return Promise.resolve();
    },
    relayFor: () => fakeRelay,
  })
);

const env = { PUBLIC_APP_URL: APP_ORIGIN } as unknown as Env;

const call = (path: string, init: RequestInit = {}) =>
  app.request(`http://localhost/agents${path}`, init, env);

/** A write from this server's own page, as the browser sends it. */
const write = (
  method: "POST" | "PUT",
  body: unknown,
  headers: Record<string, string> = { Origin: "http://localhost" }
): RequestInit => ({
  body: body === undefined ? undefined : JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
  method,
});

const statusJson = {
  connected: true,
  control: null,
  desktop: true,
  desktopUnavailableReason: null,
  youHaveControl: false,
};

beforeEach(() => {
  signedInAs = "user-1";
  requests = [];
  takes = [];
  releases = [];
  hands = [];
  connected = true;
  control = null;
  failWith = null;
  takeOutcome = {
    control: { expiresAt: 1, holder: { kind: "human", userId: "user-1" } },
    ok: true,
  };
  releaseOutcome = { clipboardCleared: true, released: true };
});

describe("desktop status", () => {
  test("GET desktop reports the host, its desktop, and who holds control", async () => {
    control = {
      expiresAt: 123,
      holder: { kind: "human", userId: "user-1" },
    };

    const res = await call("/a1/desktop");

    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({
      connected: true,
      control: { expiresAt: 123, holder: { kind: "human", userId: "user-1" } },
      desktop: true,
      desktopUnavailableReason: null,
      youHaveControl: true,
    });
  });

  test("youHaveControl is false while an agent holds the desktop", async () => {
    control = { expiresAt: 123, holder: { agentId: "a1", kind: "agent" } };

    const body = await (await call("/a1/desktop")).json();

    expect(body).toMatchObject({ youHaveControl: false });
  });

  test("an agent with no computer host is not found", async () => {
    const res = await call("/a-none/desktop");

    expect(res.status).toBe(404);
  });
});

describe("desktop screenshot", () => {
  test("a person gets a JPEG that is never cached, without holding control", async () => {
    const res = await call("/a1/desktop/screenshot");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG_BYTES);
    expect(requests[0]?.principal).toEqual({ kind: "human", userId: "user-1" });
  });

  test.each([
    [failed("human_in_control"), 423, "human_in_control"],
    [failed("forbidden"), 423, "lease_required"],
    [failed("desktop_busy"), 409, "clearing"],
    [failed("desktop_unavailable"), 503, "desktop_unavailable"],
    [failed("client_error", "desktop_unavailable"), 503, "desktop_unavailable"],
    [failed("client_error", "tool_failed"), 502, "desktop_failed"],
    [failed("offline"), 503, "offline"],
    [failed("timeout"), 503, "offline"],
  ] as const)(
    "a refused op answers %j with %i and the error %s",
    async (outcome, status, error) => {
      failWith = outcome;

      const res = await call("/a1/desktop/screenshot");

      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error });
    }
  );
});

describe("desktop input", () => {
  test("input is sent for the person, and answered with a fresh JPEG", async () => {
    const res = await call(
      "/a1/desktop/input",
      write("POST", { actions: [{ text: "hi", type: "type" }] })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(requests.map((request) => request.message.op)).toEqual([
      "desktop_input",
      "desktop_screenshot",
    ]);
    expect(requests[0]?.principal).toEqual({ kind: "human", userId: "user-1" });
  });

  test("a batch that is empty or malformed is refused before it is sent", async () => {
    const res = await call("/a1/desktop/input", write("POST", { actions: [] }));

    expect(res.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  test("a refused input answers with the refusal, not a frame", async () => {
    failWith = failed("forbidden");

    const res = await call(
      "/a1/desktop/input",
      write("POST", { actions: [{ text: "hi", type: "type" }] })
    );

    expect(res.status).toBe(423);
    expect(await res.json()).toMatchObject({ error: "lease_required" });
    expect(requests).toHaveLength(1);
  });
});

describe("desktop clipboard", () => {
  test("GET returns the text, and PUT sets both selections", async () => {
    const read = await call("/a1/desktop/clipboard");
    const set = await call(
      "/a1/desktop/clipboard",
      write("PUT", { text: "hi" })
    );

    expect((await read.json()) as unknown).toEqual({ text: "copied" });
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(set.status).toBe(204);
    expect(requests[1]?.message).toMatchObject({
      op: "desktop_clipboard_set",
      selections: ["clipboard", "primary"],
      text: "hi",
    });
  });
});

describe("origin of cookie writes", () => {
  test("a write from another site is refused before anything is sent", async () => {
    const res = await call(
      "/a1/desktop/clipboard",
      write("PUT", { text: "x" }, { Origin: "https://evil.example" })
    );

    expect(res.status).toBe(403);
    expect(requests).toHaveLength(0);
  });

  test("a write with no Origin is refused", async () => {
    const res = await call(
      "/a1/desktop/clipboard",
      write("PUT", { text: "x" }, {})
    );

    expect(res.status).toBe(403);
    expect(requests).toHaveLength(0);
  });

  test("the request's own origin and PUBLIC_APP_URL are both accepted", async () => {
    const own = await call(
      "/a1/desktop/clipboard",
      write("PUT", { text: "x" }, { Origin: "http://localhost" })
    );
    const configured = await call(
      "/a1/desktop/clipboard",
      write("PUT", { text: "x" }, { Origin: APP_ORIGIN })
    );

    expect(own.status).toBe(204);
    expect(configured.status).toBe(204);
  });

  test("a bearer-authenticated write is not cookie-authenticated, so it skips the check", async () => {
    const res = await call(
      "/a1/desktop/clipboard",
      write("PUT", { text: "x" }, { Authorization: "Bearer token" })
    );

    expect(res.status).toBe(204);
  });
});

describe("take control", () => {
  test("taking control returns the status with the person as holder", async () => {
    control = {
      expiresAt: 1,
      holder: { kind: "human", userId: "user-1" },
    };

    const res = await call(
      "/a1/desktop/take-control",
      write("POST", undefined)
    );

    expect(res.status).toBe(200);
    expect(takes).toEqual(["user-1"]);
    expect((await res.json()) as unknown).toEqual({
      ...statusJson,
      control: { expiresAt: 1, holder: { kind: "human", userId: "user-1" } },
      youHaveControl: true,
    });
  });

  test("a machine that is offline cannot be taken over", async () => {
    connected = false;

    const res = await call(
      "/a1/desktop/take-control",
      write("POST", undefined)
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "offline" });
    expect(takes).toHaveLength(0);
  });

  test("a desktop whose clipboard is still being cleared answers clearing", async () => {
    takeOutcome = {
      message: "clipboard not cleared yet",
      ok: false,
      reason: "desktop_busy",
    };

    const res = await call(
      "/a1/desktop/take-control",
      write("POST", undefined)
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "clearing" });
  });
});

describe("hand back", () => {
  test("handing back fires the takeover hook with the note, after the lease is released", async () => {
    const res = await call(
      "/a1/desktop/hand-back",
      write("POST", { note: "done" })
    );

    expect(res.status).toBe(200);
    expect(releases).toEqual(["user-1"]);
    expect(hands).toEqual([
      { agentId: "a1", note: "done", userId: "user-1", workspaceId: "ws-1" },
    ]);
    expect((await res.json()) as unknown).toEqual(statusJson);
  });

  test("a hand-back with no body is accepted, and the note is null", async () => {
    await call("/a1/desktop/hand-back", write("POST", undefined));

    expect(hands).toEqual([
      { agentId: "a1", note: null, userId: "user-1", workspaceId: "ws-1" },
    ]);
  });

  test("a person who holds no control gets lease_required and nothing is handed back", async () => {
    releaseOutcome = { clipboardCleared: false, released: false };

    const res = await call("/a1/desktop/hand-back", write("POST", {}));

    expect(res.status).toBe(423);
    expect(await res.json()).toMatchObject({ error: "lease_required" });
    expect(hands).toHaveLength(0);
  });
});

describe("default takeover hook", () => {
  test("is a no-op until the takeover flow is built", async () => {
    await expect(
      onHandBack({ agentId: "a1", note: null, userId: "u", workspaceId: "w" })
    ).resolves.toBeUndefined();
  });
});
