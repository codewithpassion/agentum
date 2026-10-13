import { describe, expect, it } from "bun:test";
import {
  createDesktopServer,
  DesktopApiError,
  desktopUrl,
  readDesktopFailure,
  toDesktopStatus,
  toFrameProblem,
  type WireDesktopStatus,
} from "./desktop-api";

const idle: WireDesktopStatus = {
  connected: true,
  control: null,
  desktop: true,
  desktopUnavailableReason: null,
  youHaveControl: false,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const recorder = (respond: (url: string, init: RequestInit) => Response) => {
  const calls: { init: RequestInit; url: string }[] = [];
  const fetcher = (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ init, url });
    return Promise.resolve(respond(url, init));
  };
  return { calls, fetcher };
};

/** The relay sends the lease deadline as epoch milliseconds. */
const EXPIRES_MS = Date.parse("2026-10-13T10:05:00Z");

const failureOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("expected the call to be refused");
    },
    (error: unknown) => error
  );

describe("desktop routes", () => {
  it("builds workspace-scoped agent desktop URLs with each part encoded", () => {
    expect(desktopUrl("acme co", "agent/1")).toBe(
      "/api/w/acme%20co/agents/agent%2F1/desktop"
    );
    expect(desktopUrl("acme", "a1", "/input")).toBe(
      "/api/w/acme/agents/a1/desktop/input"
    );
  });

  it("maps the wire status to the view's controller shapes", () => {
    expect(toDesktopStatus(idle)).toEqual({
      controller: { kind: "none" },
      desktop: true,
      desktopUnavailableReason: null,
      online: true,
      pendingTakeover: null,
    });
    expect(
      toDesktopStatus({
        ...idle,
        control: {
          expiresAt: EXPIRES_MS,
          holder: { kind: "agent" },
        },
      }).controller
    ).toEqual({ kind: "agent" });
    expect(
      toDesktopStatus({
        ...idle,
        control: {
          expiresAt: EXPIRES_MS,
          holder: { kind: "human", userId: "u1" },
        },
        youHaveControl: true,
      }).controller
    ).toEqual({
      expiresAt: "2026-10-13T10:05:00.000Z",
      isMe: true,
      kind: "human",
    });
    expect(
      toDesktopStatus({
        ...idle,
        connected: false,
        control: {
          expiresAt: EXPIRES_MS,
          holder: { kind: "human", userId: "u2" },
        },
      })
    ).toMatchObject({
      controller: { isMe: false, kind: "human" },
      online: false,
    });
  });

  it("turns the relay's epoch-millisecond lease deadline into a parseable ISO time", () => {
    const { controller } = toDesktopStatus({
      ...idle,
      control: {
        expiresAt: EXPIRES_MS,
        holder: { kind: "human", userId: "u1" },
      },
      youHaveControl: true,
    });
    expect(controller).toEqual({
      expiresAt: "2026-10-13T10:05:00.000Z",
      isMe: true,
      kind: "human",
    });
    if (controller.kind !== "human") {
      throw new Error("expected a human controller");
    }
    expect(Number.isNaN(Date.parse(controller.expiresAt))).toBe(false);
  });

  it("carries the pending takeover the status route reports", () => {
    expect(
      toDesktopStatus({
        ...idle,
        pendingTakeover: { createdAt: 5, id: "q1", reason: "Log in" },
      }).pendingTakeover
    ).toEqual({ createdAt: 5, id: "q1", reason: "Log in" });
  });

  it("cancels a takeover with a POST and returns the settled question", async () => {
    const { calls, fetcher } = recorder(() =>
      json({ question: { id: "q1", status: "cancelled" } })
    );
    const question = await createDesktopServer("acme", fetcher).cancelTakeover({
      agentId: "a1",
    });
    expect(question).toMatchObject({ id: "q1", status: "cancelled" });
    expect(calls[0]?.url).toBe("/api/w/acme/agents/a1/desktop/cancel-takeover");
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("reads the status route and maps it", async () => {
    const { calls, fetcher } = recorder(() => json(idle));
    const server = createDesktopServer("acme", fetcher);
    const status = await server.getDesktopStatus({ agentId: "a1" });
    expect(status.online).toBe(true);
    expect(calls[0]?.url).toBe("/api/w/acme/agents/a1/desktop");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("takes control with a POST and maps the answer", async () => {
    const { calls, fetcher } = recorder(() =>
      json({
        ...idle,
        control: {
          expiresAt: EXPIRES_MS,
          holder: { kind: "human", userId: "u1" },
        },
        youHaveControl: true,
      })
    );
    const status = await createDesktopServer(
      "acme",
      fetcher
    ).takeDesktopControl({
      agentId: "a1",
    });
    expect(calls[0]?.url).toBe("/api/w/acme/agents/a1/desktop/take-control");
    expect(calls[0]?.init.method).toBe("POST");
    expect(status.controller).toMatchObject({ isMe: true, kind: "human" });
  });

  it("hands back with an optional note", async () => {
    const { calls, fetcher } = recorder(() => json(idle));
    const server = createDesktopServer("acme", fetcher);
    await server.handBackDesktop({ agentId: "a1" });
    await server.handBackDesktop({ agentId: "a1", note: "Logged in" });
    expect(calls[0]?.url).toBe("/api/w/acme/agents/a1/desktop/hand-back");
    expect(calls[0]?.init.body).toBe("{}");
    expect(calls[1]?.init.body).toBe(JSON.stringify({ note: "Logged in" }));
  });

  it("sends input as a JSON batch and returns the frame as a blob", async () => {
    const { calls, fetcher } = recorder(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/jpeg" },
        })
    );
    const frame = await createDesktopServer("acme", fetcher).sendDesktopInput({
      actions: [{ keys: "Return", type: "key" }],
      agentId: "a1",
    });
    expect(calls[0]?.url).toBe("/api/w/acme/agents/a1/desktop/input");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ actions: [{ keys: "Return", type: "key" }] })
    );
    expect(frame.size).toBe(3);
  });

  it("passes the abort signal to the screenshot request", async () => {
    const { calls, fetcher } = recorder(
      () => new Response(new Uint8Array([1]))
    );
    const controller = new AbortController();
    await createDesktopServer("acme", fetcher).getDesktopScreenshot({
      agentId: "a1",
      signal: controller.signal,
    });
    expect(calls[0]?.url).toBe("/api/w/acme/agents/a1/desktop/screenshot");
    expect(calls[0]?.init.signal).toBe(controller.signal);
  });

  it("reads and writes the clipboard", async () => {
    const { calls, fetcher } = recorder((url) =>
      url.endsWith("/clipboard")
        ? json({ text: "copied" })
        : new Response(null, { status: 204 })
    );
    const server = createDesktopServer("acme", fetcher);
    expect(await server.getDesktopClipboard({ agentId: "a1" })).toEqual({
      text: "copied",
    });
    await server.setDesktopClipboard({ agentId: "a1", text: "paste me" });
    expect(calls[1]?.init.method).toBe("PUT");
    expect(calls[1]?.init.body).toBe(JSON.stringify({ text: "paste me" }));
  });
});

describe("desktop failures", () => {
  it("rejects a refused call with its status and error word", async () => {
    const { fetcher } = recorder(() =>
      json({ error: "human_in_control" }, 423)
    );
    const error = await failureOf(
      createDesktopServer("acme", fetcher).sendDesktopInput({
        actions: [],
        agentId: "a1",
      })
    );
    expect(error).toBeInstanceOf(DesktopApiError);
    expect(readDesktopFailure(error)).toEqual({
      code: "human_in_control",
      message: "Another person is in control of this desktop.",
      statusCode: 423,
    });
    expect(toFrameProblem(error)).toEqual({ kind: "human_in_control" });
  });

  it("names the lease and transport refusals in words", async () => {
    const lease = await failureOf(
      createDesktopServer(
        "acme",
        recorder(() => json({ error: "lease_required" }, 423)).fetcher
      ).setDesktopClipboard({ agentId: "a1", text: "x" })
    );
    expect(readDesktopFailure(lease)?.message).toBe(
      "Take control before you use the desktop."
    );
  });

  it("maps each refusal to the frame problem the view shows", async () => {
    const problemFor = async (status: number, body: unknown) =>
      toFrameProblem(
        await failureOf(
          createDesktopServer(
            "acme",
            recorder(() => json(body, status)).fetcher
          ).getDesktopScreenshot({ agentId: "a1" })
        )
      );
    expect(await problemFor(409, { error: "clearing" })).toEqual({
      kind: "clearing",
    });
    expect(await problemFor(503, { error: "offline" })).toEqual({
      kind: "offline",
    });
    expect(await problemFor(503, { error: "desktop_unavailable" })).toEqual({
      kind: "unavailable",
      message: "This computer has no desktop.",
    });
    expect(await problemFor(502, { error: "desktop_failed" })).toEqual({
      kind: "failed",
      message: "The desktop did not answer. Try again.",
    });
  });

  it("falls back to the status when a refusal has no JSON body", async () => {
    const error = await failureOf(
      createDesktopServer(
        "acme",
        recorder(() => new Response("<html>forbidden</html>", { status: 403 }))
          .fetcher
      ).getDesktopStatus({ agentId: "a1" })
    );
    expect(readDesktopFailure(error)).toEqual({
      code: null,
      message: "Request failed (403).",
      statusCode: 403,
    });
  });

  it("reads no failure from anything that is not a refused desktop call", () => {
    expect(readDesktopFailure(new Error("network down"))).toBeNull();
    expect(readDesktopFailure("boom")).toBeNull();
    expect(toFrameProblem(new Error("network down"))).toEqual({
      kind: "failed",
      message: "network down",
    });
  });
});
