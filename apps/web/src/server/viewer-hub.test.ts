import { beforeEach, describe, expect, test } from "bun:test";
import type {
  ComputerOutcome,
  ComputerPrincipal,
  ComputerStatus,
} from "@repo/services/machines/types";
import { relayFailure } from "./desktop-failure.ts";
import {
  createViewerHub,
  FRAME_INTERVAL_MS,
  IDLE_INTERVAL_MS,
  MAX_UNACKED_FRAMES,
  RETRY_AFTER_FAILURE_MS,
  type ViewerHub,
  type ViewerSocket,
} from "./viewer-hub.ts";

/**
 * The viewer pump: who is sent a frame, how many frames may be in flight, and
 * what input is refused. The host is a fake; the lease rules are in the relay's tests.
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeViewer extends ViewerSocket {
  attachment: unknown;
  sent: (string | ArrayBuffer)[];
}

const viewerFor = (userId: string): FakeViewer => {
  const socket: FakeViewer = {
    attachment: { kind: "viewer", userId },
    deserializeAttachment: () => socket.attachment,
    send: (data) => {
      socket.sent.push(data);
    },
    sent: [],
  };
  return socket;
};

const texts = (viewer: FakeViewer): Record<string, unknown>[] =>
  viewer.sent
    .filter((data): data is string => typeof data === "string")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
const binaries = (viewer: FakeViewer): ArrayBuffer[] =>
  viewer.sent.filter((data): data is ArrayBuffer => typeof data !== "string");
const frameId = (frame: ArrayBuffer | undefined): number =>
  frame === undefined ? -1 : new DataView(frame).getUint32(0);

const jpegResult = (bytes: number[]): string =>
  JSON.stringify({
    data_b64: btoa(String.fromCharCode(...bytes)),
    height: 800,
    media_type: "image/jpeg",
    width: 1280,
  });

const ok = (resultJson: string): ComputerOutcome => ({ ok: true, resultJson });
const refused = (
  reason: Extract<ComputerOutcome, { ok: false }>["reason"],
  code: string | null = null
): ComputerOutcome => ({
  code,
  message: `refused: ${reason}`,
  ok: false,
  reason,
});

let control: ComputerStatus["control"];
let screenshot: ComputerOutcome;
let inputOutcome: ComputerOutcome;
let screenshots: ComputerPrincipal[];
let inputs: { principal: ComputerPrincipal; actions: unknown }[];
let now: number;
let sleeps: (() => void)[] = [];
let hub: ViewerHub<FakeViewer>;
let held: FakeViewer[] = [];

const makeHub = () =>
  createViewerHub<FakeViewer>(
    {
      desktopInput: (principal, input) => {
        inputs.push({ actions: input.actions, principal });
        return Promise.resolve(inputOutcome);
      },
      desktopScreenshot: (principal) => {
        screenshots.push(principal);
        return Promise.resolve(screenshot);
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
          connected: true,
          control,
          hostname: "box",
          inFlightExec: 0,
          lastSeenAt: null,
          queued: 0,
          version: "1",
          workdir: "/w",
        }),
      viewerSockets: () => held,
    },
    {
      clock: () => now,
      sleep: () =>
        new Promise<void>((resolve) => {
          sleeps.push(resolve);
        }),
    }
  );

const captures = () => screenshots;

beforeEach(async () => {
  // Let the previous test's pump finish: every viewer gone, then one sleep released.
  for (const wake of sleeps) {
    wake();
  }
  await flush();
  held = [];
  hub = makeHub();
  control = null;
  screenshot = ok(jpegResult([1, 2, 3]));
  inputOutcome = ok('{"ok":true}');
  screenshots = [];
  inputs = [];
  now = 1_000_000;
  sleeps = [];
});

describe("viewer pump", () => {
  test("a new viewer is told the status and sent a binary frame with an id header", async () => {
    const viewer = viewerFor("u1");

    hub.open(viewer);
    await flush();

    expect(texts(viewer)[0]).toMatchObject({
      connected: true,
      desktop: true,
      t: "status",
      youHaveControl: false,
    });
    const [frame] = binaries(viewer);
    expect(frameId(frame)).toBeGreaterThan(0);
    expect(Array.from(new Uint8Array(frame ?? new ArrayBuffer(0), 4))).toEqual([
      1, 2, 3,
    ]);
    expect(captures()[0]).toEqual({ kind: "human", userId: "u1" });
    hub.close(viewer);
  });

  test("the pump stops when the last viewer leaves", async () => {
    const viewer = viewerFor("u1");
    hub.open(viewer);
    await flush();
    expect(hub.pumping).toBe(true);

    hub.close(viewer);
    for (const wake of sleeps) {
      wake();
    }
    await flush();

    expect(hub.pumping).toBe(false);
    expect(hub.viewerCount).toBe(0);
  });

  test("an identical frame is not sent again", async () => {
    const viewer = viewerFor("u1");
    hub.open(viewer);
    await flush();
    const first = binaries(viewer).length;
    hub.message(
      viewer,
      JSON.stringify({ id: frameId(binaries(viewer)[0]), t: "ack" })
    );

    await hub.tick();

    expect(captures().length).toBeGreaterThan(1);
    expect(binaries(viewer)).toHaveLength(first);
    hub.close(viewer);
  });

  test("a changed frame is sent, and a viewer holds at most two un-acked", async () => {
    const viewer = viewerFor("u1");
    hub.open(viewer);
    await flush();
    let byte = 10;
    for (let i = 0; i < 5; i += 1) {
      byte += 1;
      screenshot = ok(jpegResult([byte]));
      // biome-ignore lint/performance/noAwaitInLoops: each capture settles before the next
      await hub.tick();
    }

    expect(binaries(viewer)).toHaveLength(MAX_UNACKED_FRAMES);
    const before = captures().length;
    // Both frames unacked: nothing is captured at all.
    await hub.tick();
    expect(captures()).toHaveLength(before);

    hub.message(
      viewer,
      JSON.stringify({ id: frameId(binaries(viewer)[1]), t: "ack" })
    );
    screenshot = ok(jpegResult([99]));
    await hub.tick();
    expect(binaries(viewer)).toHaveLength(MAX_UNACKED_FRAMES + 1);
    hub.close(viewer);
  });

  test("a slow viewer is skipped while a fast one keeps getting frames", async () => {
    const slow = viewerFor("slow");
    const fast = viewerFor("fast");
    hub.open(slow);
    hub.open(fast);
    await flush();
    for (let i = 0; i < 6; i += 1) {
      screenshot = ok(jpegResult([20 + i]));
      const latest = binaries(fast).at(-1);
      if (latest) {
        hub.message(fast, JSON.stringify({ id: frameId(latest), t: "ack" }));
      }
      // biome-ignore lint/performance/noAwaitInLoops: each capture settles before the next
      await hub.tick();
    }

    expect(binaries(slow)).toHaveLength(MAX_UNACKED_FRAMES);
    expect(binaries(fast).length).toBeGreaterThan(MAX_UNACKED_FRAMES);
    hub.close(slow);
    hub.close(fast);
  });

  test("a failing desktop is reported once and retried slowly", async () => {
    screenshot = refused("offline");
    const viewer = viewerFor("u1");
    hub.open(viewer);
    await flush();

    expect(texts(viewer).filter((m) => m.t === "problem")).toEqual([
      { code: "offline", message: "refused: offline", t: "problem" },
    ]);
    const asked = captures().length;
    await hub.tick();
    expect(captures()).toHaveLength(asked);

    now += RETRY_AFTER_FAILURE_MS;
    await hub.tick();
    expect(captures()).toHaveLength(asked + 1);
    expect(texts(viewer).filter((m) => m.t === "problem")).toHaveLength(1);
    hub.close(viewer);
  });

  test("a viewer is never shown frames while another person holds the desktop", async () => {
    control = {
      expiresAt: now + 1000,
      holder: { kind: "human", userId: "u2" },
    };
    const watcher = viewerFor("u1");
    const holder = viewerFor("u2");
    hub.open(watcher);
    hub.open(holder);
    await flush();

    await hub.tick();

    expect(binaries(watcher)).toHaveLength(0);
    expect(texts(watcher)).toContainEqual(
      expect.objectContaining({ code: "human_in_control", t: "problem" })
    );
    expect(binaries(holder).length).toBeGreaterThan(0);
    hub.close(watcher);
    hub.close(holder);
  });
});

describe("viewer input", () => {
  const click = [{ button: "left", count: 1, type: "click", x: 5, y: 6 }];

  test("input goes to the host as the viewer's person, with no reply", async () => {
    const viewer = viewerFor("u1");
    hub.open(viewer);
    await flush();

    hub.message(viewer, JSON.stringify({ actions: click, t: "input" }));
    await flush();

    expect(inputs).toEqual([
      { actions: click, principal: { kind: "human", userId: "u1" } },
    ]);
    expect(texts(viewer).some((m) => m.t === "error")).toBe(false);
    hub.close(viewer);
  });

  test("input without the lease is answered with lease_required", async () => {
    inputOutcome = refused("forbidden");
    const viewer = viewerFor("u1");
    hub.open(viewer);
    await flush();

    hub.message(viewer, JSON.stringify({ actions: click, t: "input" }));
    await flush();

    expect(texts(viewer)).toContainEqual(
      expect.objectContaining({ code: "lease_required", t: "error" })
    );
    hub.close(viewer);
  });

  test("another person's hold is answered with human_in_control", async () => {
    inputOutcome = refused("human_in_control");
    const viewer = viewerFor("u1");
    hub.open(viewer);
    await flush();

    hub.message(viewer, JSON.stringify({ actions: click, t: "input" }));
    await flush();

    expect(texts(viewer)).toContainEqual(
      expect.objectContaining({ code: "human_in_control", t: "error" })
    );
    hub.close(viewer);
  });

  test.each([
    "not json",
    JSON.stringify({ actions: [], t: "input" }),
    JSON.stringify({ actions: [{ type: "rm" }], t: "input" }),
    JSON.stringify({
      actions: [{ keys: "ctrl+l; rm", type: "key" }],
      t: "input",
    }),
    JSON.stringify({ t: "other" }),
  ])("a message that fails validation is ignored: %s", async (raw) => {
    const viewer = viewerFor("u1");
    hub.open(viewer);
    await flush();

    hub.message(viewer, raw);
    await flush();

    expect(inputs).toHaveLength(0);
    hub.close(viewer);
  });

  test("a status change pushes each viewer its own youHaveControl", async () => {
    const mine = viewerFor("u1");
    const theirs = viewerFor("u2");
    hub.open(mine);
    hub.open(theirs);
    await flush();
    control = {
      expiresAt: now + 1000,
      holder: { kind: "human", userId: "u1" },
    };

    hub.statusChanged();
    await flush();

    expect(texts(mine).at(-1)).toMatchObject({
      t: "status",
      youHaveControl: true,
    });
    expect(texts(theirs).at(-1)).toMatchObject({
      t: "status",
      youHaveControl: false,
    });
    hub.close(mine);
    hub.close(theirs);
  });
});

describe("viewer pump recovery and pacing", () => {
  test("a viewer the hub forgot is taken back by the next status change", async () => {
    const forgotten = viewerFor("u1");
    held = [forgotten];
    expect(hub.viewerCount).toBe(0);

    hub.statusChanged();
    await flush();

    expect(hub.viewerCount).toBe(1);
    expect(texts(forgotten)[0]).toMatchObject({ t: "status" });
    expect(binaries(forgotten).length).toBeGreaterThan(0);
    hub.close(forgotten);
  });

  test("an unchanged screen backs the pump off, and a change or input brings it back", async () => {
    const viewer = viewerFor("u1");
    hub.open(viewer);
    await flush();
    const ack = () =>
      hub.message(
        viewer,
        JSON.stringify({ id: frameId(binaries(viewer).at(-1)), t: "ack" })
      );
    ack();
    await hub.tick();
    const idle = captures().length;

    now += FRAME_INTERVAL_MS;
    await hub.tick();
    expect(captures()).toHaveLength(idle);

    now += IDLE_INTERVAL_MS;
    screenshot = ok(jpegResult([42]));
    await hub.tick();
    expect(captures()).toHaveLength(idle + 1);
    ack();

    now += FRAME_INTERVAL_MS;
    await hub.tick();
    expect(captures()).toHaveLength(idle + 2);

    await hub.tick();
    now += FRAME_INTERVAL_MS;
    hub.message(
      viewer,
      JSON.stringify({
        actions: [{ keys: "Return", type: "key" }],
        t: "input",
      })
    );
    await hub.tick();
    expect(captures().length).toBeGreaterThan(idle + 2);
    hub.close(viewer);
  });
});

describe("relayFailure", () => {
  const failure = (
    reason: Extract<ComputerOutcome, { ok: false }>["reason"],
    code: string | null = null
  ) => relayFailure({ code, message: "m", ok: false, reason });

  test("a person holding the desktop is 423 human_in_control", () => {
    expect(failure("human_in_control")).toEqual({
      error: "human_in_control",
      message: "m",
      status: 423,
    });
  });

  test("a missing lease is 423 lease_required with the fixed message", () => {
    expect(failure("forbidden")).toEqual({
      error: "lease_required",
      message: "Take control of the desktop first.",
      status: 423,
    });
  });

  test("a client that reports desktop_unavailable is 503, other client errors are 502", () => {
    expect(failure("client_error", "desktop_unavailable").status).toBe(503);
    expect(failure("client_error", "op_failed")).toEqual({
      error: "desktop_failed",
      message: "m",
      status: 502,
    });
  });

  test("reasons the desktop path never produced fall to offline 503", () => {
    expect(failure("timeout")).toEqual({
      error: "offline",
      message: "m",
      status: 503,
    });
    expect(failure("queue_full").error).toBe("offline");
  });
});
