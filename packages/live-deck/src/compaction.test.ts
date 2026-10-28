import { expect, test } from "bun:test";
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  getItem,
  getState,
  ID,
  Item,
  XmlElement,
  XmlFragment,
  type XmlText,
} from "yjs";
import capture from "./fixtures/structural-migration.json";
import { Deck } from "./index";

import { StaleAncestryError, validatePositionMigrations } from "./migrations";
import { richTextCodec } from "./rich-text";

const bytes = new Uint8Array(capture.state);
const ROOT = "__tiptap_position_migrations:item:4007255768:47";
const FRAGMENT = new ID(4_007_255_768, 47);
const TEXT = new ID(1_354_242_215, 9);

function deckWith(compactions?: { count: number }, state = bytes) {
  const deck = new Deck(new Doc(), richTextCodec, {
    onCompact: () => {
      if (compactions) {
        compactions.count += 1;
      }
    },
  });
  deck.applyUpdate(state);
  return deck;
}
/** A peer editing the fixture scene, handing out the updates an editor would send. */
function peerOf(deck: Deck, gc = false) {
  const doc = new Doc({ gc });
  applyUpdate(doc, encodeStateAsUpdate(deck.doc));
  return doc;
}
function diff(doc: Doc, from: Uint8Array) {
  return encodeStateAsUpdate(doc, from);
}
function textOf(doc: Doc): XmlText {
  const item = getItem(doc.store, TEXT);
  if (!(item instanceof Item && "type" in item.content)) {
    throw new Error("fixture text missing");
  }
  return item.content.type as XmlText;
}
function fragmentOf(doc: Doc): XmlFragment {
  const item = getItem(doc.store, FRAGMENT) as Item;
  return (item.content as unknown as { type: XmlFragment }).type;
}
/** One list toggle on a long paragraph: the characters are replaced and a record maps old to new. */
function toggle(doc: Doc, length: number) {
  const text = textOf(doc);
  const before = encodeStateVector(doc);
  doc.transact(() => {
    const old = text._start;
    if (!old) {
      throw new Error("text empty");
    }
    const source = { client: old.id.client, clock: old.id.clock, length };
    text.delete(0, text.length);
    text.insert(0, "x".repeat(length));
    const created = text._start;
    if (!created) {
      throw new Error("insert lost");
    }
    const clock = getState(doc.store, doc.clientID);
    doc.getMap(ROOT).set(`${doc.clientID}:${clock}`, {
      client: doc.clientID,
      clock,
      seen: [[doc.clientID, clock]],
      transfers: [
        {
          source,
          target: {
            client: created.id.client,
            clock: created.id.clock,
            type: { client: TEXT.client, clock: TEXT.clock },
          },
        },
      ],
      version: 1,
    });
  });
  return diff(doc, before);
}

test("A1: a 10k-character paragraph toggled 250 times stays editable", () => {
  const compactions = { count: 0 };
  const deck = deckWith(compactions);
  const peer = peerOf(deck);
  const start = encodeStateVector(peer);
  peer.transact(() => textOf(peer).insert(0, "x".repeat(10_000)));
  deck.applyUpdate(diff(peer, start));
  for (let i = 0; i < 250; i += 1) {
    deck.applyUpdate(toggle(peer, 10_000));
  }
  deck.validate();
  // Past the old 2M position budget a window must have rolled over.
  expect(compactions.count).toBeGreaterThan(0);
  const fresh = new Deck(new Doc(), richTextCodec);
  fresh.applyUpdate(encodeStateAsUpdate(deck.doc));
  expect(fresh.read("opening").slide).toEqual(deck.read("opening").slide);
});

test("A2: deleted payloads cannot fill the scene limit", () => {
  const compactions = { count: 0 };
  const deck = deckWith(compactions);
  const peer = peerOf(deck);
  const blob = "y".repeat(900_000);
  for (let i = 0; i < 40; i += 1) {
    const before = encodeStateVector(peer);
    peer.transact(() => {
      peer.getMap("meta").set("junk", blob + i);
      peer.getMap("meta").delete("junk");
    });
    deck.applyUpdate(diff(peer, before));
  }
  expect(compactions.count).toBeGreaterThan(0);
  expect(encodeStateAsUpdate(deck.doc).byteLength).toBeLessThan(8_000_000);
  // Still editable.
  const before = encodeStateVector(peer);
  peer.getMap("meta").set("title", "after");
  deck.applyUpdate(diff(peer, before));
  expect(deck.doc.getMap("meta").get("title")).toBe("after");
});

test("A3: validation reads the update, not the history", () => {
  const deck = deckWith();
  const peer = peerOf(deck);
  const start = encodeStateVector(peer);
  peer.transact(() => textOf(peer).insert(0, "x".repeat(1000)));
  deck.applyUpdate(diff(peer, start));
  for (let i = 0; i < 300; i += 1) {
    deck.applyUpdate(toggle(peer, 1000));
  }
  const since = new Map(
    [...deck.doc.store.clients.keys()].map((c) => [
      c,
      getState(deck.doc.store, c),
    ])
  );
  const before = encodeStateVector(peer);
  const update = toggle(peer, 1000);
  deck.applyUpdate(update);
  const scan = validatePositionMigrations(deck.doc, {
    allow: { positions: 1e9, records: 1e9, transfers: 1e9, vectors: 1e9 },
    since,
  });
  expect(scan.usage.records).toBe(1);
  expect(before.length).toBeGreaterThan(0);
  const { window } = deck.usage();
  expect(window.records).toBeGreaterThanOrEqual(1);
});

test("restore after compaction replaces the scene and clears migration state", () => {
  const deck = deckWith();
  deck.compact();
  deck.validate();
  expect(deck.usage().live.records).toBe(1);
  deck.restore(bytes);
  expect(deck.usage().live.records).toBe(0);
  expect(deck.usage().window.records).toBe(0);
  deck.compact();
  deck.validate();
  expect(deck.ids().sort()).toEqual(["closing", "opening"]);
  // A later reload of the compacted state is accepted.
  const reloaded = new Deck(new Doc(), richTextCodec);
  reloaded.applyUpdate(encodeStateAsUpdate(deck.doc));
  expect(reloaded.read("opening").slide).toEqual(deck.read("opening").slide);
});

test("restore refuses hostile migration roots and leaves the scene alone", () => {
  const deck = deckWith();
  const before = encodeStateAsUpdate(deck.doc);
  const hostile = new Doc({ gc: false });
  applyUpdate(hostile, bytes);
  hostile.getMap(ROOT).set("hidden", { secret: true });
  expect(() => deck.restore(encodeStateAsUpdate(hostile))).toThrow();
  expect(encodeStateAsUpdate(deck.doc)).toEqual(before);
});

test("compaction keeps referenced ancestry and drops the rest", () => {
  const deck = deckWith();
  const peer = peerOf(deck);
  const start = encodeStateVector(peer);
  peer.transact(() => {
    textOf(peer).insert(0, "scratch text that nothing references");
    textOf(peer).delete(0, 20);
  });
  deck.applyUpdate(diff(peer, start));
  const grown = encodeStateAsUpdate(deck.doc).byteLength;
  deck.compact();
  expect(encodeStateAsUpdate(deck.doc).byteLength).toBeLessThan(grown);
  deck.validate();
  // The captured record still resolves its deleted source ancestry.
  const source = getItem(deck.doc.store, new ID(4_007_255_768, 50));
  expect(source).toBeInstanceOf(Item);
});

test("peers keep editing across a compaction and converge, whatever their gc setting", () => {
  const server = deckWith();
  const keeper = peerOf(server, false);
  const collector = peerOf(server, true);
  const send = (doc: Doc, from: Uint8Array) => {
    const update = diff(doc, from);
    server.applyUpdate(update);
    return update;
  };
  // Concurrent edits made before either peer hears about the compaction.
  const keeperStart = encodeStateVector(keeper);
  const collectorStart = encodeStateVector(collector);
  textOf(keeper).insert(0, "A");
  fragmentOf(collector).insert(0, []);
  collector.getMap("meta").set("title", "from collector");
  server.compact();
  const fromKeeper = send(keeper, keeperStart);
  const fromCollector = send(collector, collectorStart);
  applyUpdate(keeper, fromCollector);
  applyUpdate(collector, fromKeeper);
  // Edits after the compaction build on the same ids.
  const later = encodeStateVector(keeper);
  textOf(keeper).insert(0, "B");
  applyUpdate(collector, send(keeper, later));
  server.compact();
  const final = encodeStateAsUpdate(server.doc);
  const joiner = new Deck(new Doc(), richTextCodec);
  joiner.applyUpdate(final);
  for (const doc of [keeper, collector, joiner.doc]) {
    expect(textOf(doc).toString()).toBe(textOf(server.doc).toString());
    expect(doc.getMap("meta").get("title")).toBe("from collector");
  }
  expect(textOf(server.doc).toString()).toContain("BA");
});

test("an update built on ancestry compaction removed is refused whole", () => {
  const server = deckWith();
  const stale = peerOf(server);
  // The authority deletes the slide and drops its records, then compacts.
  const admin = peerOf(server);
  const adminStart = encodeStateVector(admin);
  admin.transact(() => {
    admin.getMap("slides").delete("opening");
    admin.getMap(ROOT).clear();
  });
  server.applyUpdate(diff(admin, adminStart));
  server.compact();
  expect(getItem(server.doc.store, TEXT)).not.toBeInstanceOf(Item);
  const before = encodeStateAsUpdate(server.doc);
  const staleStart = encodeStateVector(stale);
  stale.transact(() => {
    const clock = getState(stale.store, stale.clientID);
    stale.getMap(ROOT).set(`${stale.clientID}:${clock}`, {
      client: stale.clientID,
      clock,
      seen: [],
      transfers: [
        {
          source: { client: TEXT.client, clock: TEXT.clock, length: 1 },
          target: null,
        },
      ],
      version: 1,
    });
  });
  expect(() => server.applyUpdate(diff(stale, staleStart))).toThrow(
    StaleAncestryError
  );
  expect(encodeStateAsUpdate(server.doc)).toEqual(before);
});

test("gc:true peers: collected migration payloads are accepted", () => {
  const server = deckWith();
  const peer = peerOf(server, true);
  const start = encodeStateVector(peer);
  peer.transact(() => {
    peer.getMap(ROOT).set("scratch", { gone: true });
    peer.getMap(ROOT).delete("scratch");
  });
  // A gc:true encoder ships the deleted entry as collected content, not as data.
  expect(() => server.applyUpdate(diff(peer, start))).not.toThrow();
  server.validate();
});

test("a replaced fragment compacts to a state that still reloads", () => {
  const server = deckWith();
  const admin = peerOf(server);
  const start = encodeStateVector(admin);
  admin.transact(() => {
    admin.getMap(ROOT).clear();
    const elements = admin.getMap("slides").get("opening") as unknown as {
      get: (k: string) => {
        get: (k: string) => { set: (k: string, v: unknown) => void };
      };
    };
    const fragment = new XmlFragment();
    fragment.insert(0, [new XmlElement("paragraph")]);
    elements.get("elements").get("headline").set("text", fragment);
  });
  server.applyUpdate(diff(admin, start));
  server.compact();
  server.validate();
  const reloaded = new Deck(new Doc(), richTextCodec);
  reloaded.applyUpdate(encodeStateAsUpdate(server.doc));
  expect(reloaded.ids().sort()).toEqual(["closing", "opening"]);
});
