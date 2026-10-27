/** biome-ignore-all lint/suspicious/useAwait: Unit transport callbacks intentionally resolve immediately. */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Deck } from "@repo/live-deck";
import { richTextCodec } from "@repo/live-deck/rich-text";
import type { LiveJoinResult } from "@repo/protocol/live";
import { Window } from "happy-dom";
import {
  createEncoder,
  toUint8Array,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import { Doc, encodeStateAsUpdate } from "yjs";
import { TicketedDeckRoom } from "./room-provider";

class Socket {
  static readonly OPEN = 1;
  static instances: Socket[] = [];
  readonly readyState = 1;
  readonly sent: (string | Uint8Array)[] = [];
  onmessage?: (event: { data: string | ArrayBuffer }) => void;
  onclose?: () => void;
  constructor(_url: string) {
    Socket.instances.push(this);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.();
  }
  receive(data: object | Uint8Array) {
    this.onmessage?.({
      data:
        data instanceof Uint8Array
          ? new Uint8Array(data).buffer
          : JSON.stringify(data),
    });
  }
}
const previous = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  for (const [key, value] of [
    ["window", new Window({ url: "https://room.test" })],
    ["WebSocket", Socket],
  ] as const) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});
afterAll(() => {
  for (const [key, value] of previous) {
    if (value) {
      Object.defineProperty(globalThis, key, value);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});
const rooms: TicketedDeckRoom[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) {
    room.dispose();
    room.deck.destroy();
    room.document.destroy();
  }
  Socket.instances = [];
});
const joined: LiveJoinResult = {
  participant: {
    color: "#123456",
    id: "alice",
    kind: "member",
    name: "Trusted Alice",
  },
  role: "owner",
  roomUrl: "/room",
  ticket: "unit-ticket",
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
function checkpoint(initialized = true) {
  const doc = new Doc();
  const deck = new Deck(doc, richTextCodec);
  if (initialized) {
    deck.setTheme({ colors: {}, fonts: {}, sizes: {} });
  }
  const bytes = encodeStateAsUpdate(doc);
  deck.destroy();
  doc.destroy();
  return bytes;
}
function sync(update: Uint8Array) {
  const encoder = createEncoder();
  writeVarUint(encoder, 0);
  writeVarUint(encoder, 1);
  writeVarUint8Array(encoder, update);
  return toUint8Array(encoder);
}
async function connect() {
  let failure = "";
  let ready = false;
  const room = new TicketedDeckRoom({
    failed: (message) => {
      failure = message;
    },
    join: async () => joined,
    policy: async () => new Set(),
    ready: () => {
      ready = true;
    },
    roleChanged: () => undefined,
  });
  rooms.push(room);
  await room.connect();
  const socket = Socket.instances.at(-1);
  if (!socket) {
    throw new Error("Missing socket");
  }
  return { failure: () => failure, ready: () => ready, room, socket };
}
function session(socket: Socket) {
  socket.receive({
    awarenessId: 9001,
    expiresAt: Date.now() + 300_000,
    kind: "deck",
    role: "owner",
    type: "session",
  });
}
test("requires trusted session assignment before applying network structs", async () => {
  const client = await connect();
  client.socket.receive(sync(checkpoint()));
  await tick();
  expect(client.ready()).toBe(false);
  expect(client.failure()).toContain("assignment");
  expect(client.room.document.getMap("meta").size).toBe(0);
});
test("requires authority theme initialization and never creates competing theme maps", async () => {
  const client = await connect();
  session(client.socket);
  client.socket.receive(sync(checkpoint(false)));
  await tick();
  expect(client.failure()).toContain("theme");
  expect(client.room.document.getMap("meta").has("theme")).toBe(false);
});
test("validates hostile authority update before changing the replica", async () => {
  const client = await connect();
  session(client.socket);
  const hostile = new Doc();
  hostile.getMap("unexpected").set("payload", "bad");
  client.socket.receive(sync(encodeStateAsUpdate(hostile)));
  await tick();
  expect(client.ready()).toBe(false);
  expect(client.failure()).toContain("unknown root");
  expect(client.room.document.getMap("unexpected").size).toBe(0);
  hostile.destroy();
});
test("assigns awareness ID independently and does not echo accepted checkpoint", async () => {
  const client = await connect();
  const docId = client.room.document.clientID;
  session(client.socket);
  client.socket.receive(sync(checkpoint()));
  await tick();
  expect(client.ready()).toBe(true);
  expect(client.room.awareness.clientID).toBe(9001);
  expect(client.room.document.clientID).toBe(docId);
  const before = client.socket.sent.length;
  client.room.deck.setTheme({
    colors: { accent: "#123456" },
    fonts: {},
    sizes: {},
  });
  expect(client.socket.sent.length).toBe(before + 1);
});
test("role downgrade discards connection and refuses subsequent presentation", async () => {
  const client = await connect();
  session(client.socket);
  client.socket.receive(sync(checkpoint()));
  await tick();
  client.socket.receive({ role: "viewer", type: "role" });
  await tick();
  expect(client.failure()).toContain("permissions");
  await expect(
    client.room.presentToEveryone({ build: 0, slideId: "gone" })
  ).rejects.toThrow("permission");
});
test("presentation admission waits for acknowledgement and serialized release handles delayed start", async () => {
  const client = await connect();
  session(client.socket);
  client.socket.receive(sync(checkpoint()));
  await tick();
  const start = client.room.presentToEveryone({ build: 0, slideId: "slide" });
  const release = client.room.presentToEveryone(null);
  await tick();
  const request = JSON.parse(String(client.socket.sent.at(-1)));
  expect(request.action).toBe("acquire");
  client.socket.receive({
    expiresAt: Date.now() + 15_000,
    leaseId: "lease",
    ok: true,
    requestId: request.requestId,
    type: "presentation-result",
  });
  await start;
  await tick();
  const stop = JSON.parse(String(client.socket.sent.at(-1)));
  expect(stop.action).toBe("release");
  expect(stop.leaseId).toBe("lease");
  client.socket.receive({
    ok: true,
    requestId: stop.requestId,
    type: "presentation-result",
  });
  await release;
});
