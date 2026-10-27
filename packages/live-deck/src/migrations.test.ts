import { expect, test } from "bun:test";
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  getState,
  ID,
  type XmlFragment,
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
