import { describe, expect, test } from "bun:test";
import {
  applyUpdate as YapplyUpdate,
  Doc as YDoc,
  encodeStateAsUpdate as YencodeStateAsUpdate,
  Map as YMap,
  XmlElement as YXmlElement,
  XmlFragment as YXmlFragment,
  XmlText as YXmlText,
} from "yjs";
import {
  Deck,
  generateKeyBetween,
  type Node,
  parseSlide,
  type RichTextCodec,
  type SlideData,
  serializeSlide,
} from "./index";

// Test codec deliberately implements only paragraphs with plain text; production supplies L.2.
const codec: RichTextCodec = {
  parse(nodes, target) {
    for (const node of nodes) {
      if (
        typeof node === "string" ||
        node.tag !== "p" ||
        Object.keys(node.attrs).length ||
        node.children.some((x) => typeof x !== "string")
      ) {
        throw new Error("bad paragraph");
      }
      const p = new YXmlElement("p");
      const text = new YXmlText();
      text.insert(0, node.children.join(""));
      p.insert(0, [text]);
      target.insert(target.length, [p]);
    }
  },
  serialize(source) {
    return source.toArray().map((p): Node => {
      if (!(p instanceof YXmlElement) || p.nodeName !== "p") {
        throw new Error("bad paragraph");
      }
      return {
        attrs: {},
        children: [
          p
            .toArray()
            .map((x) => x.toString())
            .join(""),
        ],
        tag: "p",
      };
    });
  },
};
const slide = (id: string, order = "a0"): SlideData => ({
  background: "#fff",
  duration: "0",
  elements: [
    {
      id: `${id}e`,
      order: "a0",
      parent: id,
      props: { h: "50", w: "100", x: "0", y: "0" },
      style: { color: "#000", "font-size": "12px" },
      text: [{ attrs: {}, children: ["hello"], tag: "p" }],
      type: "text",
    },
  ],
  id,
  layout: { display: "flex" },
  notes: "notes",
  order,
  transition: "none",
});
function replica(source: YDoc) {
  const d = new YDoc();
  YapplyUpdate(d, YencodeStateAsUpdate(source));
  return d;
}
function sync(a: YDoc, b: YDoc) {
  const u = YencodeStateAsUpdate(a);
  const v = YencodeStateAsUpdate(b);
  YapplyUpdate(a, v);
  YapplyUpdate(b, u);
}
describe("deck", () => {
  test("independent property edits merge and concurrent slide moves never duplicate", () => {
    const a = new YDoc();
    const deck = new Deck(a, codec);
    deck.addSlide(slide("s1"));
    deck.addSlide(slide("s2", generateKeyBetween("a0", null)));
    deck.addSlide(slide("s3", generateKeyBetween("a1", null)));
    const b = replica(a);
    const other = new Deck(b, codec);
    deck.setElementKey("s1", "s1e", "style", "color", "#f00");
    other.setElementKey("s1", "s1e", "style", "font-size", "20px");
    deck.moveSlide("s2", null, "s1");
    other.moveSlide("s2", "s3", null);
    sync(a, b);
    expect(deck.read("s1").slide.elements[0]?.style).toEqual({
      color: "#f00",
      "font-size": "20px",
    });
    expect(deck.ids()).toEqual(other.ids());
    expect(new Set(deck.ids()).size).toBe(3);
  });
  test("agent skips human changed elements and applies other changes", () => {
    const doc = new YDoc();
    const deck = new Deck(doc, codec);
    const s = slide("s");
    s.elements.push({ ...first(s.elements), id: "other" });
    deck.addSlide(s);
    const observed = deck.read("s");
    const desired = structuredClone(observed.slide);
    first(desired.elements).style.color = "#123";
    at(desired.elements, 1).style.color = "#456";
    deck.setElementKey("s", "other", "style", "font-size", "30px");
    const result = deck.write("s", serializeSlide(desired, codec), observed);
    expect(result.skipped.map((x) => x.id)).toEqual(["other"]);
    expect(
      deck.read("s").slide.elements.find((x) => x.id === "se")?.style.color
    ).toBe("#456");
    expect(
      deck.read("s").slide.elements.find((x) => x.id === "other")?.style.color
    ).toBe("#000");
  });
  test("hostile input is rejected without mutation", () => {
    const doc = new YDoc();
    const deck = new Deck(doc, codec);
    deck.addSlide(slide("s"));
    const observed = deck.read("s");
    const html = serializeSlide(observed.slide, codec);
    for (const bad of [
      html.replace("<p>", "<script>"),
      html.replace(
        'style-color="#000"',
        'style-color="url(javascript:alert(1))"'
      ),
      html.replace("<element ", '<element onclick="x" '),
      html.replace("<p>", '<img src="https://evil.test" />'),
      html.replace("<p>", "<!--x--><p>"),
      html.replace("<p>", '<a href="javascript:alert(1)">'),
      html.replace("<slide ", "<!DOCTYPE slide><slide "),
    ]) {
      expect(() => deck.write("s", bad, observed)).toThrow("/");
      expect(deck.read("s")).toEqual(observed);
    }
    expect(parseSlide(html, codec)).toEqual(observed.slide);
  });
  test("limits and malformed values fail", () => {
    const s = slide("s");
    first(s.elements).props.src = "https://evil.test/x";
    expect(() => serializeSlide(s, codec)).toThrow();
    const many = slide("s");
    many.elements = Array.from({ length: 201 }, (_, i) => ({
      ...first(many.elements),
      id: `e${i}`,
    }));
    expect(() => serializeSlide(many, codec)).toThrow("limit");
  });
});

function at<T>(items: T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error("missing test fixture");
  }
  return value;
}
function first<T>(items: T[]): T {
  return at(items, 0);
}

describe("authoritative boundaries", () => {
  test("human edit then revert invalidates element and slide guards", () => {
    const deck = new Deck(new YDoc(), codec);
    deck.addSlide(slide("s"));
    const observed = deck.read("s");
    const desired = structuredClone(observed.slide);
    first(desired.elements).style.color = "#123";
    desired.background = "#123";
    deck.setElementKey("s", "se", "style", "color", "#f00");
    deck.setElementKey("s", "se", "style", "color", "#000");
    deck.updateSlide("s", { background: "#f00" });
    deck.updateSlide("s", { background: "#fff" });
    expect(deck.write("s", serializeSlide(desired, codec), observed)).toEqual({
      applied: [],
      skipped: [
        { id: "se", reason: "changed since read" },
        { id: "s", reason: "background changed since read" },
      ],
    });
  });
  test("observations are retained opaque capabilities, detached and bounded", () => {
    const doc = new YDoc();
    const deck = new Deck(doc, codec, { maxObservations: 1 });
    deck.addSlide(slide("s"));
    const observed = deck.read("s");
    const forged = structuredClone(observed);
    first(forged.slide.elements).style.color = "#f00";
    expect(() =>
      deck.write("s", serializeSlide(forged.slide, codec), forged)
    ).toThrow("observation");
    expect(() =>
      new Deck(doc, codec).write(
        "s",
        serializeSlide(observed.slide, codec),
        observed
      )
    ).toThrow("observation");
    deck.setElementKey("s", "se", "style", "color", "#f00");
    deck.read("s");
    expect(() =>
      deck.write("s", serializeSlide(observed.slide, codec), observed)
    ).toThrow("expired");
  });
  test("remote ABA and delete/recreate cannot evade guards", () => {
    const doc = new YDoc();
    const deck = new Deck(doc, codec);
    deck.addSlide(slide("s"));
    const observed = deck.read("s");
    const remote = new Deck(replica(doc), codec);
    remote.setElementKey("s", "se", "style", "color", "#f00");
    remote.setElementKey("s", "se", "style", "color", "#000");
    deck.applyUpdate(YencodeStateAsUpdate(remote.doc));
    const desired = structuredClone(observed.slide);
    first(desired.elements).style.color = "#123";
    expect(
      deck.write("s", serializeSlide(desired, codec), observed).skipped
    ).toHaveLength(1);
    const next = deck.read("s");
    deck.deleteSlide("s");
    deck.addSlide(slide("s"));
    expect(
      deck.write("s", serializeSlide(desired, codec), next).skipped
    ).toHaveLength(1);
  });
  test("candidate validation keeps original CRDT identities and convergence", () => {
    const doc = new YDoc();
    const deck = new Deck(doc, codec);
    deck.addSlide(slide("s"));
    deck.addSlide(slide("t", "a1"));
    const other = new Deck(replica(doc), codec);
    deck.setElementKey("s", "se", "props", "x", "20");
    other.setElementKey("s", "se", "style", "color", "#f00");
    deck.moveSlide("t", null, "s");
    other.moveSlide("t", "s", null);
    const a = YencodeStateAsUpdate(doc),
      b = YencodeStateAsUpdate(other.doc);
    deck.applyUpdate(b);
    other.applyUpdate(a);
    expect(YencodeStateAsUpdate(doc)).toEqual(YencodeStateAsUpdate(other.doc));
    expect(first(deck.read("s").slide.elements).props.x).toBe("20");
    expect(first(deck.read("s").slide.elements).style.color).toBe("#f00");
    expect(deck.ids()).toHaveLength(2);
    deck.applyUpdate(b);
    expect(YencodeStateAsUpdate(doc)).toEqual(YencodeStateAsUpdate(other.doc));
  });
  test("malicious Yjs updates are rejected atomically", () => {
    const deck = new Deck(new YDoc(), codec);
    deck.addSlide(slide("s"));
    const baseline = YencodeStateAsUpdate(deck.doc);
    const observation = deck.read("s");
    const attacks: ((doc: YDoc) => void)[] = [
      (doc) => doc.getMap("unknown").set("script", "alert(1)"),
      (doc) => scene(doc).set("notes", "not Y.Text"),
      (doc) => element(doc).set("onclick", "alert(1)"),
      (doc) =>
        fieldMap(element(doc), "style").set("color", "url(javascript:x)"),
      (doc) => element(doc).set("parent", "se"),
      (doc) => fieldMap(element(doc), "props").set("src", "/files/other/x"),
      (doc) => element(doc).set("cells", new YMap()),
      (doc) => {
        const fragment = element(doc).get("text");
        if (!(fragment instanceof YXmlFragment)) {
          throw new Error("fixture");
        }
        fragment.insert(0, [new YXmlElement("script")]);
      },
      (doc) => fieldMap(element(doc), "style").set("font-family", "Unlisted"),
      (doc) => doc.getMap("meta").set("theme", new YMap()),
    ];
    for (const attack of attacks) {
      const hostile = replica(deck.doc);
      attack(hostile);
      expect(() => deck.applyUpdate(YencodeStateAsUpdate(hostile))).toThrow();
      expect(YencodeStateAsUpdate(deck.doc)).toEqual(baseline);
      expect(deck.read("s")).toEqual(observation);
    }
    expect(() => deck.applyUpdate(new Uint8Array([255, 0, 42]))).toThrow();
    expect(YencodeStateAsUpdate(deck.doc)).toEqual(baseline);
  });
  test("incomplete update dependencies are refused before they can be buffered", () => {
    const source = new YDoc();
    const remote = new Deck(source, codec);
    remote.addSlide(slide("s"));
    const updates: Uint8Array[] = [];
    source.on("update", (update: Uint8Array) => updates.push(update));
    remote.setElementKey("s", "se", "style", "color", "#f00");
    const deck = new Deck(new YDoc(), codec);
    expect(() => deck.applyUpdate(first(updates))).toThrow("dependencies");
    expect(deck.ids()).toEqual([]);
    deck.applyUpdate(YencodeStateAsUpdate(source));
    expect(first(deck.read("s").slide.elements).style.color).toBe("#f00");
  });
  test("restore validates first, replaces scene and converges as a new transaction", () => {
    const deck = new Deck(new YDoc(), codec);
    deck.addSlide(slide("s"));
    const observed = deck.read("s");
    const baseline = YencodeStateAsUpdate(deck.doc);
    const invalid = replica(deck.doc);
    scene(invalid).set("background", "expression(x)");
    expect(() => deck.restore(YencodeStateAsUpdate(invalid))).toThrow();
    expect(YencodeStateAsUpdate(deck.doc)).toEqual(baseline);
    const other = new Deck(replica(deck.doc), codec);
    const checkpoint = new Deck(new YDoc(), codec);
    checkpoint.addSlide(slide("replacement"));
    deck.restore(YencodeStateAsUpdate(checkpoint.doc));
    other.applyUpdate(YencodeStateAsUpdate(deck.doc));
    expect(deck.ids()).toEqual(["replacement"]);
    expect(other.ids()).toEqual(deck.ids());
    expect(YencodeStateAsUpdate(other.doc)).toEqual(
      YencodeStateAsUpdate(deck.doc)
    );
    expect(() =>
      deck.write("s", serializeSlide(observed.slide, codec), observed)
    ).toThrow("observation");
  });
});

function scene(doc: YDoc): YMap<unknown> {
  return fieldMap(doc.getMap("slides"), "s");
}
function element(doc: YDoc): YMap<unknown> {
  return fieldMap(fieldMap(scene(doc), "elements"), "se");
}
function fieldMap(parent: YMap<unknown>, key: string): YMap<unknown> {
  const value = parent.get(key);
  if (!(value instanceof YMap)) {
    throw new Error(`fixture ${key}`);
  }
  return value;
}
