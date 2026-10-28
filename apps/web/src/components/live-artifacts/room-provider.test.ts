/** biome-ignore-all lint/suspicious/useAwait: Test transport callbacks model async network ports. */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { awarenessEntrySchema, type LiveJoinResult } from "@repo/protocol/live";
import { Window } from "happy-dom";
import {
  createDecoder,
  readVarString,
  readVarUint,
  readVarUint8Array,
} from "lib0/decoding";
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
  const parsed = entry === null ? null : awarenessEntrySchema.parse(entry);
  const wire = parsed
    ? {
        cursor: parsed.cursor,
        pointer: parsed.pointer,
        selection: parsed.selection,
        slideId: parsed.slideId,
        status: parsed.status,
        user: {
          color: parsed.color,
          id: parsed.id,
          kind: parsed.kind,
          name: parsed.name,
        },
      }
    : null;
  writeVarString(payload, JSON.stringify(wire));
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
  // The editor cursor plugin clears local cursor on blur/remote updates. The
  // explicit attachment must still be the room's canonical outgoing context.
  room.awareness.setLocalStateField("cursor", null);
  const outgoing = socket.sent.at(-1) as Uint8Array;
  const decoder = createDecoder(outgoing);
  expect(readVarUint(decoder)).toBe(1);
  const payload = createDecoder(readVarUint8Array(decoder));
  readVarUint(payload);
  readVarUint(payload);
  readVarUint(payload);
  expect(JSON.parse(readVarString(payload))).toEqual({
    cursor: { anchor: selection.start, head: selection.end },
  });
  room.clearSelection();
  const cleared = createDecoder(socket.sent.at(-1) as Uint8Array);
  readVarUint(cleared);
  const clearedPayload = createDecoder(readVarUint8Array(cleared));
  readVarUint(clearedPayload);
  readVarUint(clearedPayload);
  readVarUint(clearedPayload);
  expect(JSON.parse(readVarString(clearedPayload))).toEqual({});

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

test("renews with a newly issued ticket before expiry and accepts the renewal acknowledgement", async () => {
  let joins = 0;
  const failures: string[] = [];
  const room = new TicketedRoom({
    failed: (message) => failures.push(message),
    join: async () => {
      joins += 1;
      return { ...joined, ticket: `ticket-${joins}` };
    },
    policy: async () => new Set(),
    ready: () => {
      /* No content required for renewal control. */
    },
    roleChanged: () => {
      /* No role change expected. */
    },
  });
  rooms.push(room);
  const socket = await session(room, Date.now() + 60_100);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(joins).toBe(2);
  expect(socket.sent.filter((item) => typeof item === "string")).toContain(
    JSON.stringify({ ticket: "ticket-2", type: "renew" })
  );
  socket.receive(
    JSON.stringify({ expiresAt: Date.now() + 900_000, type: "renewed" })
  );
  await settle();
  expect(failures).toEqual([]);
});
test("inbound frames after sync apply without awaiting a policy fetch, then the policy refreshes", async () => {
  let urls = new Set(["/files/old.png"]);
  let fetches = 0;
  let release: () => void = () => undefined;
  let gate: Promise<void> | undefined;
  const { room } = setup(async () => {
    fetches += 1;
    await gate;
    return urls;
  });
  const socket = await session(room);
  const server = new Doc();
  socket.receive(sync(server));
  await settle();
  expect(room.policy.ownBlobUrls.has("/files/old.png")).toBe(true);
  urls = new Set(["/files/new.png"]);
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = fetches;
  server.getText("test").insert(0, "remote update");
  socket.receive(sync(server, 2));
  await settle();
  expect(room.document.getText("test").toString()).toBe("remote update");
  expect(fetches).toBe(before + 1);
  expect(room.policy.ownBlobUrls.has("/files/old.png")).toBe(true);
  release();
  await settle();
  expect(room.policy.ownBlobUrls.has("/files/new.png")).toBe(true);
  expect(room.policy.ownBlobUrls.has("/files/old.png")).toBe(false);
  server.destroy();
});

test("access loss still stops the room without a policy fetch", async () => {
  let fetches = 0;
  const { failures, room } = setup(async () => {
    fetches += 1;
    return new Set();
  });
  const socket = await session(room);
  const server = new Doc();
  socket.receive(sync(server));
  await settle();
  const before = fetches;
  socket.receive(JSON.stringify({ role: "viewer", type: "role" }));
  await settle();
  expect(failures).toEqual([
    "Document permissions changed. Reconnect to refresh access.",
  ]);
  server.getText("test").insert(0, "late frame");
  socket.receive(sync(server, 2));
  await settle();
  expect(fetches).toBe(before);
  server.destroy();
});

test("Tiptap blur cursor and user fields are translated to the room's bounded presence protocol", async () => {
  const { room } = setup();
  const socket = await session(room);
  room.awareness.setLocalState({
    cursor: null,
    status: "FORGED STATUS",
    user: { id: "forged", name: "FORGED" },
  });
  const outgoing = socket.sent.at(-1);
  if (!(outgoing instanceof Uint8Array)) {
    throw new Error("Missing presence frame");
  }
  const frame = createDecoder(outgoing);
  expect(readVarUint(frame)).toBe(1);
  const payload = createDecoder(readVarUint8Array(frame));
  expect(readVarUint(payload)).toBe(1);
  expect(readVarUint(payload)).toBe(42);
  readVarUint(payload);
  expect(JSON.parse(readVarString(payload))).toEqual({});
});

test("Yjs relative-position instances normalize null fields before publishing", async () => {
  const { room } = setup();
  const socket = await session(room);
  room.awareness.setLocalStateField("cursor", {
    anchor: {
      assoc: 0,
      item: { client: 12, clock: 2 },
      tname: null,
      type: { client: 12, clock: 1 },
    },
    head: { assoc: 0, item: null, tname: null, type: { client: 12, clock: 1 } },
  });
  const outgoing = socket.sent.at(-1);
  if (!(outgoing instanceof Uint8Array)) {
    throw new Error("Missing canonical presence frame");
  }
  const outer = createDecoder(outgoing);
  readVarUint(outer);
  const decoder = createDecoder(readVarUint8Array(outer));
  readVarUint(decoder);
  readVarUint(decoder);
  readVarUint(decoder);
  expect(JSON.parse(readVarString(decoder))).toEqual({
    cursor: {
      anchor: {
        assoc: 0,
        item: { client: 12, clock: 2 },
        type: { client: 12, clock: 1 },
      },
      head: { assoc: 0, type: { client: 12, clock: 1 } },
    },
  });
});

test("renewal-discovered downgrade disposes before a matching role control can bypass fresh-state resync", async () => {
  let joins = 0;
  const failures: string[] = [];
  const roles: string[] = [];
  const room = new TicketedRoom({
    failed: (message) => failures.push(message),
    join: async () => {
      joins += 1;
      return { ...joined, role: joins === 1 ? "owner" : "viewer" };
    },
    policy: async () => new Set(),
    ready: () => {
      /* State observation is through the document below. */
    },
    roleChanged: (role) => roles.push(role),
  });
  rooms.push(room);
  const socket = await session(room, Date.now() + 60_100);
  const accepted = new Doc();
  accepted.getText("test").insert(0, "Accepted");
  socket.receive(sync(accepted));
  await settle();
  room.document.getText("test").insert(0, "Unaccepted ");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(roles).toEqual(["owner", "viewer"]);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("permissions changed");
  expect(socket.sent.filter((value) => typeof value === "string")).toHaveLength(
    0
  );
  socket.receive(JSON.stringify({ role: "viewer", type: "role" }));
  await settle();
  expect(failures).toHaveLength(1);
  const rejoined = setup();
  const next = await session(rejoined.room);
  next.receive(sync(accepted));
  await settle();
  expect(rejoined.room.document.getText("test").toString()).toBe("Accepted");
  expect(rejoined.room.document).not.toBe(room.document);
  accepted.destroy();
});

test("authoritative agent ranges reach the policy snapshot before remote content and disappear on the next manifest", async () => {
  const changes = [
    {
      end: { assoc: -1, tname: "content" },
      id: "change",
      name: "Trusted agent",
      start: { tname: "content" },
      text: "agent words",
    },
  ];
  let current = changes;
  const room = new TicketedRoom({
    failed: (message) => {
      throw new Error(message);
    },
    join: async () => joined,
    policy: async () => ({
      agentChanges: current,
      ownBlobUrls: new Set<string>(),
    }),
    ready: () => {
      /* Snapshot asserted below. */
    },
    roleChanged: () => {
      /* No authorization change here. */
    },
  });
  rooms.push(room);
  const socket = await session(room);
  const server = new Doc();
  server.getText("test").insert(0, "agent words");
  let delivered = 0;
  const unsubscribe = room.subscribePolicy(() => {
    delivered += 1;
    expect(room.document.getText("test").toString().length).toBeGreaterThan(0);
  });
  let observedBeforeContent = false;
  room.document.on("update", () => {
    observedBeforeContent = room.getAgentChanges() === current;
  });
  socket.receive(sync(server));
  await settle();
  expect(observedBeforeContent).toBe(true);
  expect(room.getAgentChanges()).toEqual(changes);
  expect(delivered).toBe(1);
  current = [];
  server.getText("test").insert(0, "human ");
  socket.receive(sync(server, 2));
  await settle();
  expect(room.getAgentChanges()).toEqual([]);
  expect(delivered).toBe(2);
  unsubscribe();
  server.destroy();
});
