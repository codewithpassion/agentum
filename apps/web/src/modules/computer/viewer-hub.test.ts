import { beforeEach, describe, expect, test } from "bun:test";
import type { ComputerPrincipal, RelayOutcome, RelayStatus } from "./relay";
import {
  DesktopViewers,
  MAX_UNACKED_FRAMES,
  RETRY_AFTER_FAILURE_MS,
} from "./viewer-hub";

/**
 * The viewer pump: who is sent a frame, how many frames may be in flight, and
 * what input is refused. The relay is a fake; its lease rules are in relay.test.ts.
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeViewer {
  attachment: unknown;
  deserializeAttachment: () => unknown;
  send: (data: string | ArrayBuffer) => void;
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

const asSocket = (viewer: FakeViewer) => viewer as unknown as WebSocket;
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

const ok = (result: string): RelayOutcome => ({
  code: null,
  message: "",
  ok: true,
  reason: null,
  result_json: result,
});
const refused = (
  reason: NonNullable<RelayOutcome["reason"]>,
  code: string | null = null
): RelayOutcome => ({
  code,
  message: `refused: ${reason}`,
  ok: false,
  reason,
  result_json: null,
});

let control: RelayStatus["control"];
let screenshot: RelayOutcome;
let inputOutcome: RelayOutcome;
let requests: { message: Record<string, unknown>; principal: unknown }[];
let now: number;
let sleeps: (() => void)[] = [];
let hub: DesktopViewers;

const makeHub = () =>
  new DesktopViewers(
    {
      request: (message, principal: ComputerPrincipal) => {
        requests.push({ message, principal });
        return Promise.resolve(
          message.op === "desktop_input" ? inputOutcome : screenshot
        );
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
          version: "1",
          workdir: "/w",
        }),
    },
    {
      clock: () => now,
      sleep: () =>
        new Promise<void>((resolve) => {
          sleeps.push(resolve);
        }),
    }
  );

const captures = () =>
  requests.filter((r) => r.message.op === "desktop_screenshot");

beforeEach(async () => {
  // Let the previous test's pump finish: every viewer gone, then one sleep released.
  for (const wake of sleeps) {
    wake();
  }
  await flush();
  hub = makeHub();
  control = null;
  screenshot = ok(jpegResult([1, 2, 3]));
  inputOutcome = ok('{"ok":true}');
  requests = [];
  now = 1_000_000;
  sleeps = [];
});

describe("viewer pump", () => {
  test("a new viewer is told the status and sent a binary frame with an id header", async () => {
    const viewer = viewerFor("u1");

    hub.open(asSocket(viewer));
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
    expect(captures()[0]?.principal).toEqual({ kind: "human", userId: "u1" });
    hub.close(asSocket(viewer));
  });

  test("the pump stops when the last viewer leaves", async () => {
    const viewer = viewerFor("u1");
    hub.open(asSocket(viewer));
    await flush();
    expect(hub.pumping).toBe(true);

    hub.close(asSocket(viewer));
    for (const wake of sleeps) {
      wake();
    }
    await flush();

    expect(hub.pumping).toBe(false);
    expect(hub.viewerCount).toBe(0);
  });

  test("an identical frame is not sent again", async () => {
    const viewer = viewerFor("u1");
    hub.open(asSocket(viewer));
    await flush();
    const first = binaries(viewer).length;
    hub.message(
      asSocket(viewer),
      JSON.stringify({ id: frameId(binaries(viewer)[0]), t: "ack" })
    );

    await hub.tick();

    expect(captures().length).toBeGreaterThan(1);
    expect(binaries(viewer)).toHaveLength(first);
    hub.close(asSocket(viewer));
  });

  test("a changed frame is sent, and a viewer holds at most two un-acked", async () => {
    const viewer = viewerFor("u1");
    hub.open(asSocket(viewer));
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
    // Both viewers behind: nothing is captured at all.
    await hub.tick();
    expect(captures()).toHaveLength(before);

    hub.message(
      asSocket(viewer),
      JSON.stringify({ id: frameId(binaries(viewer)[1]), t: "ack" })
    );
    screenshot = ok(jpegResult([99]));
    await hub.tick();
    expect(binaries(viewer)).toHaveLength(MAX_UNACKED_FRAMES + 1);
    hub.close(asSocket(viewer));
  });

  test("a slow viewer is skipped while a fast one keeps getting frames", async () => {
    const slow = viewerFor("slow");
    const fast = viewerFor("fast");
    hub.open(asSocket(slow));
    hub.open(asSocket(fast));
    await flush();
    for (let i = 0; i < 6; i += 1) {
      screenshot = ok(jpegResult([20 + i]));
      const latest = binaries(fast).at(-1);
      if (latest) {
        hub.message(
          asSocket(fast),
          JSON.stringify({ id: frameId(latest), t: "ack" })
        );
      }
      // biome-ignore lint/performance/noAwaitInLoops: each capture settles before the next
      await hub.tick();
    }

    expect(binaries(slow)).toHaveLength(MAX_UNACKED_FRAMES);
    expect(binaries(fast).length).toBeGreaterThan(MAX_UNACKED_FRAMES);
    hub.close(asSocket(slow));
    hub.close(asSocket(fast));
  });

  test("a failing desktop is reported once and retried slowly", async () => {
    screenshot = refused("offline");
    const viewer = viewerFor("u1");
    hub.open(asSocket(viewer));
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
    hub.close(asSocket(viewer));
  });

  test("a viewer is never shown frames while another person holds the desktop", async () => {
    control = {
      expiresAt: now + 1000,
      holder: { kind: "human", userId: "u2" },
    };
    const watcher = viewerFor("u1");
    const holder = viewerFor("u2");
    hub.open(asSocket(watcher));
    hub.open(asSocket(holder));
    await flush();

    await hub.tick();

    expect(binaries(watcher)).toHaveLength(0);
    expect(texts(watcher)).toContainEqual(
      expect.objectContaining({ code: "human_in_control", t: "problem" })
    );
    expect(binaries(holder).length).toBeGreaterThan(0);
    hub.close(asSocket(watcher));
    hub.close(asSocket(holder));
  });
});

describe("viewer input", () => {
  const click = [{ button: "left", count: 1, type: "click", x: 5, y: 6 }];

  test("input goes to the relay as the viewer's person, with no reply", async () => {
    const viewer = viewerFor("u1");
    hub.open(asSocket(viewer));
    await flush();

    hub.message(
      asSocket(viewer),
      JSON.stringify({ actions: click, t: "input" })
    );
    await flush();

    const sent = requests.find((r) => r.message.op === "desktop_input");
    expect(sent?.principal).toEqual({ kind: "human", userId: "u1" });
    expect(sent?.message.actions).toEqual(click);
    expect(texts(viewer).some((m) => m.t === "error")).toBe(false);
    hub.close(asSocket(viewer));
  });

  test("input without the lease is answered with lease_required", async () => {
    inputOutcome = refused("forbidden");
    const viewer = viewerFor("u1");
    hub.open(asSocket(viewer));
    await flush();

    hub.message(
      asSocket(viewer),
      JSON.stringify({ actions: click, t: "input" })
    );
    await flush();

    expect(texts(viewer)).toContainEqual(
      expect.objectContaining({ code: "lease_required", t: "error" })
    );
    hub.close(asSocket(viewer));
  });

  test("another person's hold is answered with human_in_control", async () => {
    inputOutcome = refused("human_in_control");
    const viewer = viewerFor("u1");
    hub.open(asSocket(viewer));
    await flush();

    hub.message(
      asSocket(viewer),
      JSON.stringify({ actions: click, t: "input" })
    );
    await flush();

    expect(texts(viewer)).toContainEqual(
      expect.objectContaining({ code: "human_in_control", t: "error" })
    );
    hub.close(asSocket(viewer));
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
    hub.open(asSocket(viewer));
    await flush();

    hub.message(asSocket(viewer), raw);
    await flush();

    expect(requests.some((r) => r.message.op === "desktop_input")).toBe(false);
    hub.close(asSocket(viewer));
  });

  test("a status change pushes each viewer its own youHaveControl", async () => {
    const mine = viewerFor("u1");
    const theirs = viewerFor("u2");
    hub.open(asSocket(mine));
    hub.open(asSocket(theirs));
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
    hub.close(asSocket(mine));
    hub.close(asSocket(theirs));
  });
});
