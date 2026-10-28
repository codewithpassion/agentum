import { expect, test } from "bun:test";
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  getItem,
  getState,
  ID,
  type Item,
  XmlElement,
  type XmlFragment,
  XmlText,
  Map as YMap,
} from "yjs";
import capture from "./fixtures/structural-migration.json";
import splitCapture from "./fixtures/structural-split.json";
import { Deck } from "./index";
import { richTextCodec } from "./rich-text";

interface Migration {
  client: number;
  clock: number;
  seen: [number[], ...number[][]];
  transfers: [
    {
      source: Record<string, unknown>;
      target: Record<string, unknown> & { type: Record<string, unknown> };
    },
    ...{
      source: Record<string, unknown>;
      target: Record<string, unknown> & { type: Record<string, unknown> };
    }[],
  ];
  [key: string]: unknown;
}
const bytes = new Uint8Array(capture.state);
test("list split admits merged boundary ranges and local native Y.ID targets", () => {
  const deck = new Deck(new Doc(), richTextCodec);
  deck.applyUpdate(new Uint8Array(splitCapture.state));
  deck.validate();
  const local = replica();
  rewrite(local.doc, (v) => {
    const target = v.transfers[0].target.type;
    v.transfers[0].target.type = new ID(
      Number(target.client),
      Number(target.clock)
    ) as unknown as Record<string, unknown>;
  });
  local.validate();
  const authority = replica();
  authority.applyUpdate(encodeStateAsUpdate(local.doc));
  authority.validate();
});
function replica() {
  const deck = new Deck(new Doc(), richTextCodec);
  deck.applyUpdate(bytes);
  return deck;
}
function root(doc: Doc) {
  const name = [...doc.share.keys()].find((key) => key.startsWith("__tiptap_"));
  if (!name) {
    throw new Error("fixture migration missing");
  }
  return doc.getMap(name);
}
function rewrite(doc: Doc, change: (value: Migration) => void) {
  const store = root(doc);
  const value = structuredClone([...store.values()][0]) as Migration;
  store.clear();
  value.client = doc.clientID;
  value.clock = getState(doc.store, doc.clientID);
  change(value);
  store.set(`${value.client}:${value.clock}`, value);
}
test("captured two-browser list transform survives authority apply, restart and restore", () => {
  const deck = replica();
  expect(deck.read("opening").slide.elements.length).toBeGreaterThan(0);
  const restarted = new Deck(new Doc(), richTextCodec);
  restarted.applyUpdate(encodeStateAsUpdate(deck.doc));
  expect(restarted.read("opening").slide).toEqual(deck.read("opening").slide);
  restarted.restore(bytes);
  restarted.validate();
  expect(restarted.read("opening").slide).toEqual(deck.read("opening").slide);
  // A later structural edit must retain deleted IDs referenced by migration history.
  expect(deck.doc.gc).toBe(false);
  deck.deleteSlide("opening");
  deck.validate();
  const afterDeletion = new Deck(new Doc(), richTextCodec);
  afterDeletion.applyUpdate(encodeStateAsUpdate(deck.doc));
  expect(afterDeletion.ids()).toEqual(["closing"]);
});
test("empty local migration map accepts only a genuine scene fragment", () => {
  const deck = replica();
  root(deck.doc).clear();
  deck.validate();
  deck.doc.getMap("__tiptap_position_migrations:item:1:0");
  expect(() => deck.validate()).toThrow();
});
test("migration records reject unknown fields, malformed identities and resource abuse atomically", () => {
  const changes = [
    (v: Migration) => {
      v.secret = "hidden";
    },
    (v: Migration) => {
      v.version = 2;
    },
    (v: Migration) => {
      v.transfers[0].target.tname = "slides";
    },
    (v: Migration) => {
      v.transfers[0].source.length = 2_000_001;
    },
    (v: Migration) => {
      v.transfers[0].source.clock = -1;
    },
    (v: Migration) => {
      v.transfers[0].source.client = 1;
    },
    (v: Migration) => {
      v.transfers[0].target.type.clock = 47;
    },
    (v: Migration) => {
      v.transfers[0].target.assoc = 100;
    },
    (v: Migration) => {
      v.transfers[0].target.boundary = "elsewhere";
    },
    (v: Migration) => {
      v.seen.push(v.seen[0]);
    },
    (v: Migration) => {
      v.seen[0][1] = 0xff_ff_ff_ff;
    },
    (v: Migration) => {
      v.transfers = new Array(100_001).fill(
        v.transfers[0]
      ) as Migration["transfers"];
    },
  ];
  for (const change of changes) {
    const authority = replica();
    const remote = replica();
    rewrite(remote.doc, change);
    const before = encodeStateAsUpdate(authority.doc);
    expect(() =>
      authority.applyUpdate(encodeStateAsUpdate(remote.doc))
    ).toThrow();
    expect(encodeStateAsUpdate(authority.doc)).toEqual(before);
  }
});
test("migration source and target ranges cannot cross fragment boundaries", () => {
  for (const side of ["source", "target"] as const) {
    const remote = replica();
    const slide = remote.doc.getMap<YMap<unknown>>("slides").get("closing");
    if (!slide) {
      throw new Error("missing fixture slide");
    }
    const elements = slide.get("elements") as YMap<YMap<unknown>>;
    const text = [...elements.values()]
      .find((e) => e.has("text"))
      ?.get("text") as XmlFragment;
    const entry = text.get(0)._item;
    if (!entry) {
      throw new Error("missing fixture text");
    }
    const { id } = entry;
    rewrite(remote.doc, (v: Migration) => {
      v.transfers[0].source.length = 1;
      v.transfers[0][side].client = id.client;
      v.transfers[0][side].clock = id.clock;
    });
    expect(() =>
      replica().applyUpdate(encodeStateAsUpdate(remote.doc))
    ).toThrow();
  }
});
test("prefix lookalikes, nested shared payloads and root sequence content remain forbidden", () => {
  for (const name of [
    "hidden",
    "__tiptap_position_migrations:root:slides",
    "__tiptap_position_migrations:item:04007255768:47",
  ]) {
    const remote = replica();
    remote.doc.getMap(name).set("hidden", true);
    expect(() =>
      replica().applyUpdate(encodeStateAsUpdate(remote.doc))
    ).toThrow();
  }
  const remote = replica();
  root(remote.doc).set("nested", new YMap());
  expect(() =>
    replica().applyUpdate(encodeStateAsUpdate(remote.doc))
  ).toThrow();
  const sequence = new Doc();
  const name = [...remote.doc.share.keys()].find((key) =>
    key.startsWith("__tiptap_")
  );
  if (!name) {
    throw new Error("missing migration root");
  }
  sequence.getArray(name).push(["hidden"]);
  const candidate = replica();
  applyUpdate(candidate.doc, encodeStateAsUpdate(sequence));
  expect(() => candidate.validate()).toThrow();
});
test("deleted and overwritten migration entries cannot retain hidden payloads", () => {
  for (const payload of [
    new YMap([["hidden", "secret payload"]]),
    { hidden: "secret payload" },
  ]) {
    const remote = replica();
    const store = root(remote.doc);
    remote.doc.transact(() => {
      store.set("hidden", payload);
      store.delete("hidden");
    });
    const authority = replica();
    const before = encodeStateAsUpdate(authority.doc);
    expect(() =>
      authority.applyUpdate(encodeStateAsUpdate(remote.doc))
    ).toThrow();
    expect(encodeStateAsUpdate(authority.doc)).toEqual(before);
  }
});
function fragmentAt(doc: Doc): XmlFragment {
  const item = getItem(doc.store, new ID(4_007_255_768, 47)) as Item;
  return (item.content as unknown as { type: XmlFragment }).type;
}
test("within depth: a migration range nested more than 64 elements deep is refused", () => {
  const remote = replica();
  let node: XmlFragment = fragmentAt(remote.doc);
  for (let depth = 0; depth < 70; depth += 1) {
    const element = new XmlElement("x");
    node.insert(0, [element]);
    node = element;
  }
  const text = new XmlText();
  node.insert(0, [text]);
  text.insert(0, "c");
  const char = text._start?.id;
  const holder = text._item?.id;
  if (!(char && holder)) {
    throw new Error("deep text missing");
  }
  rewrite(remote.doc, (v: Migration) => {
    v.transfers[0].source = {
      client: char.client,
      clock: char.clock,
      length: 1,
    };
    v.transfers[0].target = {
      client: char.client,
      clock: char.clock,
      type: { client: holder.client, clock: holder.clock },
    };
  });
  const authority = replica();
  const before = encodeStateAsUpdate(authority.doc);
  expect(() =>
    authority.applyUpdate(encodeStateAsUpdate(remote.doc))
  ).toThrow();
  expect(encodeStateAsUpdate(authority.doc)).toEqual(before);
});
test("target type must match every destination item", () => {
  const remote = replica();
  const paragraph = fragmentAt(remote.doc).get(1) as XmlElement;
  // Two adjacent items from one client: a character in `first`, then `second`, a sibling element.
  const first = new XmlText();
  paragraph.insert(0, [first]);
  first.insert(0, "z");
  const second = new XmlText();
  paragraph.insert(1, [second]);
  second.insert(0, "z");
  const start = first._start?.id;
  const firstHolder = first._item?.id;
  if (!(start && firstHolder && second._item)) {
    throw new Error("destination items missing");
  }
  expect(second._item.id.clock).toBe(start.clock + 1);
  rewrite(remote.doc, (v: Migration) => {
    v.transfers[0].source = {
      client: start.client,
      clock: start.clock,
      length: 2,
    };
    v.transfers[0].target = {
      client: start.client,
      clock: start.clock,
      type: { client: firstHolder.client, clock: firstHolder.clock },
    };
  });
  const authority = replica();
  const before = encodeStateAsUpdate(authority.doc);
  expect(() =>
    authority.applyUpdate(encodeStateAsUpdate(remote.doc))
  ).toThrow();
  expect(encodeStateAsUpdate(authority.doc)).toEqual(before);
});
test("overwritten migration payloads cannot retain hidden payloads", () => {
  const remote = replica();
  const store = root(remote.doc);
  remote.doc.transact(() => {
    store.set("hidden", { secret: 1 });
    store.set("hidden", { ok: true });
  });
  const authority = replica();
  const before = encodeStateAsUpdate(authority.doc);
  expect(() =>
    authority.applyUpdate(encodeStateAsUpdate(remote.doc))
  ).toThrow();
  expect(encodeStateAsUpdate(authority.doc)).toEqual(before);
});
test("a payload set in one update and overwritten in a later one is refused", () => {
  const remote = replica();
  const store = root(remote.doc);
  const start = encodeStateVector(remote.doc);
  store.set("hidden", { secret: 1 });
  const first = encodeStateAsUpdate(remote.doc, start);
  store.set("hidden", { ok: true });
  const authority = replica();
  const before = encodeStateAsUpdate(authority.doc);
  expect(() => authority.applyUpdate(first)).toThrow();
  expect(encodeStateAsUpdate(authority.doc)).toEqual(before);
});
