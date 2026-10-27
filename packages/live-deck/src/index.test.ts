import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
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
      const p = new Y.XmlElement("p");
      const text = new Y.XmlText();
      text.insert(0, node.children.join(""));
      p.insert(0, [text]);
      target.insert(target.length, [p]);
    }
  },
  serialize(source) {
    return source.toArray().map((p): Node => {
      if (!(p instanceof Y.XmlElement) || p.nodeName !== "p") {
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
function replica(source: Y.Doc) {
  const d = new Y.Doc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(source));
  return d;
}
function sync(a: Y.Doc, b: Y.Doc) {
  const u = Y.encodeStateAsUpdate(a);
  const v = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, v);
  Y.applyUpdate(b, u);
}
describe("deck", () => {
  test("independent property edits merge and concurrent slide moves never duplicate", () => {
    const a = new Y.Doc();
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
    const doc = new Y.Doc();
    const deck = new Deck(doc, codec);
    const s = slide("s");
    s.elements.push({ ...s.elements[0]!, id: "other" });
    deck.addSlide(s);
    const observed = deck.read("s");
    const desired = structuredClone(observed.slide);
    desired.elements[0]!.style.color = "#123";
    desired.elements[1]!.style.color = "#456";
    deck.setElementKey("s", "other", "style", "font-size", "30px");
    const result = deck.write("s", serializeSlide(desired), observed);
    expect(result.skipped.map((x) => x.id)).toEqual(["other"]);
    expect(
      deck.read("s").slide.elements.find((x) => x.id === "se")?.style.color
    ).toBe("#456");
    expect(
      deck.read("s").slide.elements.find((x) => x.id === "other")?.style.color
    ).toBe("#000");
  });
  test("hostile input is rejected without mutation", () => {
    const doc = new Y.Doc();
    const deck = new Deck(doc, codec);
    deck.addSlide(slide("s"));
    const observed = deck.read("s");
    const html = serializeSlide(observed.slide);
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
      expect(() => deck.write("s", bad, observed)).toThrow(/\//);
      expect(deck.read("s")).toEqual(observed);
    }
    expect(parseSlide(html, codec)).toEqual(observed.slide);
  });
  test("limits and malformed values fail", () => {
    const s = slide("s");
    s.elements[0]!.props.src = "https://evil.test/x";
    expect(() => serializeSlide(s)).toThrow();
    const many = slide("s");
    many.elements = Array.from({ length: 201 }, (_, i) => ({
      ...many.elements[0]!,
      id: `e${i}`,
    }));
    expect(() => serializeSlide(many)).toThrow(/limit/);
  });
});
