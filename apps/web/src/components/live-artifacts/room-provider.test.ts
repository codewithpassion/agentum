/** biome-ignore-all lint/suspicious/useAwait: Test transport callbacks model async network ports. */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { LiveJoinResult } from "@repo/protocol/live";
import { Window } from "happy-dom";
import { createDecoder, readVarUint, readVarUint8Array } from "lib0/decoding";
import {
  createEncoder,
  toUint8Array,
  writeVarString,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import { Doc, encodeStateAsUpdate } from "yjs";
import { TicketedRoom } from "./room-provider";

class TestSocket {
  static readonly OPEN = 1;
  static readonly sockets: TestSocket[] = [];
  readonly sent: (string | Uint8Array)[] = [];
  readonly readyState = 1;
  binaryType = "";
  onmessage?: (event: { data: string | ArrayBuffer }) => void;
  onclose?: () => void;
  onerror?: () => void;
  readonly url: string;
  constructor(url: string | URL) {
    this.url = String(url);
    TestSocket.sockets.push(this);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.();
  }
  receive(data: string | Uint8Array) {
    this.onmessage?.({
      data: typeof data === "string" ? data : new Uint8Array(data).buffer,
    });
  }
}
const previous = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  const window = new Window({ url: "https://room.test" });
  for (const [key, value] of [
    ["window", window],
    ["WebSocket", TestSocket],
  ] as const) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});
const rooms: TicketedRoom[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) {
    room.dispose();
    room.document.destroy();
  }
  TestSocket.sockets.length = 0;
});
const joined: LiveJoinResult = {
  participant: {
    color: "#123456",
    id: "person",
    kind: "member",
    name: "Trusted person",
  },
  role: "owner",
  roomUrl: "/api/rooms/artifact",
  ticket: "single-use-ticket",
};
const sync = (document: Doc, subtype = 1) => {
  const encoder = createEncoder();
  writeVarUint(encoder, 0);
  writeVarUint(encoder, subtype);
  writeVarUint8Array(encoder, encodeStateAsUpdate(document));
  return toUint8Array(encoder);
};
const presence = (id: number, entry: unknown) => {
  const encoder = createEncoder();
  const payload = createEncoder();
  writeVarUint(payload, 1);
  writeVarUint(payload, id);
  writeVarUint(payload, 1);
  writeVarString(payload, JSON.stringify(entry));
  writeVarUint(encoder, 1);
  writeVarUint8Array(encoder, toUint8Array(payload));
  return toUint8Array(encoder);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup(
  policy: () => Promise<ReadonlySet<string>> = async () => new Set()
) {
  const failures: string[] = [];
  const roles: string[] = [];
  const ready: TicketedRoom[] = [];
  const room = new TicketedRoom({
    failed: (message) => failures.push(message),
    join: async () => joined,
    policy,
    ready: (value) => ready.push(value),
    roleChanged: (role) => roles.push(role),
  });
  rooms.push(room);
  return { failures, ready, roles, room };
}
async function session(room: TicketedRoom, expiresAt = Date.now() + 900_000) {
  await room.connect();
  const socket = TestSocket.sockets.at(-1);
  if (!socket) {
    throw new Error("Missing socket");
  }
  socket.receive(
    JSON.stringify({ awarenessId: 42, expiresAt, type: "session" })
  );
  await settle();
  return socket;
}
test("server assigns awareness identity independently and read sync waits for verified manifest", async () => {
  let allow: (urls: ReadonlySet<string>) => void = () => {
    throw new Error("Policy not requested");
  };
  const policy = new Promise<ReadonlySet<string>>((resolve) => {
    allow = resolve;
  });
  const { room, ready } = setup(() => policy);
  const docId = room.document.clientID;
  const socket = await session(room);
  expect(room.awareness.clientID).toBe(42);
  expect(room.document.clientID).toBe(docId);
  expect(socket.url).toContain(
    "wss://room.test/api/rooms/artifact?ticket=single-use-ticket"
  );
  const server = new Doc();
  server.getText("test").insert(0, "Accepted content");
  socket.receive(sync(server));
  await settle();
  expect(ready).toHaveLength(0);
  expect(room.document.getText("test").toString()).toBe("");
  allow(new Set(["/files/own.png"]));
  await settle();
  expect(ready).toEqual([room]);
  expect(room.document.getText("test").toString()).toBe("Accepted content");
  expect(room.policy.ownBlobUrls.has("/files/own.png")).toBe(true);
  server.destroy();
});
test("only trusted server presence enters roster and selection asks await canonical echo", async () => {
  const { room } = setup();
  const socket = await session(room);
  const server = new Doc();
  socket.receive(sync(server));
  await settle();
  room.awareness.setLocalStateField("user", { name: "FORGED" });
  expect(room.presence.getSnapshot()[0]?.name).toBe("Trusted person");
  socket.receive(
    presence(99, {
      color: "#abcdef",
      id: "other",
      kind: "member",
      name: "Trusted other",
    })
  );
  await settle();
  expect(
    room.presence.getSnapshot().find((entry) => entry.clientId === 99)?.name
  ).toBe("Trusted other");
  const selection = {
    end: { assoc: -1, tname: "content" },
    start: { tname: "content" },
    text: "words",
  };
  let acknowledged = false;
  const confirmation = room.confirmSelection(selection).then(() => {
    acknowledged = true;
  });
  await settle();
  expect(acknowledged).toBe(false);
  socket.receive(
    presence(42, {
      ...joined.participant,
      cursor: { anchor: selection.start, head: selection.end },
    })
  );
  await confirmation;
  expect(acknowledged).toBe(true);
  server.destroy();
});
test("renewed JSON does not enter binary decoder; errors close and fresh connection discards rejected local edits", async () => {
  const { room, failures } = setup();
  const socket = await session(room);
  const server = new Doc();
  server.getText("test").insert(0, "Accepted");
  socket.receive(sync(server));
  await settle();
  socket.receive(
    JSON.stringify({ expiresAt: Date.now() + 900_000, type: "renewed" })
  );
  await settle();
  expect(failures).toEqual([]);
  room.document.getText("test").insert(0, "Rejected");
  const outgoing = socket.sent.at(-1);
  expect(outgoing).toBeInstanceOf(Uint8Array);
  if (outgoing instanceof Uint8Array) {
    const decoder = createDecoder(outgoing);
    expect(readVarUint(decoder)).toBe(0);
    expect(readVarUint(decoder)).toBe(2);
    expect(readVarUint8Array(decoder).length).toBeGreaterThan(0);
  }
  socket.receive(JSON.stringify({ message: "unsafe_content", type: "error" }));
  await settle();
  expect(failures).toEqual(["unsafe_content"]);
  const next = setup();
  const replacement = await session(next.room);
  replacement.receive(sync(server));
  await settle();
  expect(next.room.document.getText("test").toString()).toBe("Accepted");
  server.destroy();
});
test("role downgrade freezes and requires resync; malformed controls fail closed", async () => {
  const first = setup();
  const socket = await session(first.room);
  socket.receive(JSON.stringify({ role: "viewer", type: "role" }));
  await settle();
  expect(first.roles).toEqual(["owner", "viewer"]);
  expect(first.failures[0]).toContain("permissions changed");
  const second = setup();
  const other = await session(second.room);
  other.receive(
    JSON.stringify({ awarenessId: -1, expiresAt: 123, type: "session" })
  );
  await settle();
  expect(second.failures).toHaveLength(1);
});
test("ticket cannot be sent to a foreign room origin", async () => {
  const failures: string[] = [];
  const room = new TicketedRoom({
    failed: (message) => failures.push(message),
    join: async () => ({ ...joined, roomUrl: "https://evil.test/room" }),
    policy: async () => new Set(),
    ready: () => {
      throw new Error("Must not synchronize");
    },
    roleChanged: () => {
      /* No role UI in this refusal case. */
    },
  });
  rooms.push(room);
  await room.connect();
  expect(failures).toEqual(["Untrusted room URL"]);
  expect(TestSocket.sockets).toHaveLength(0);
});
