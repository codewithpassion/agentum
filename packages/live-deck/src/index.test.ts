import { describe, expect, test } from "bun:test";
import {
  applyUpdate as YapplyUpdate,
  Doc as YDoc,
  encodeStateAsUpdate as YencodeStateAsUpdate,
  Map as YMap,
  Text as YText,
  XmlElement as YXmlElement,
  XmlFragment as YXmlFragment,
  XmlText as YXmlText,
} from "yjs";
import {
  Deck,
  generateKeyBetween,
  LIMITS,
  type Node,
  parseSlide,
  type RichTextCodec,
  type SlideData,
  serializeSlide,
  validateLinkUrl,
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
      if (
        !(p instanceof YXmlElement) ||
        p.nodeName !== "p" ||
        Object.keys(p.getAttributes()).length
      ) {
        throw new Error("bad paragraph");
      }
      return {
        attrs: {},
        children: [
          p
            .toArray()
            .map((x) => {
              if (
                !(x instanceof YXmlText) ||
                x
                  .toDelta()
                  .some(
                    (delta: {
                      insert?: unknown;
                      attributes?: Record<string, unknown>;
                    }) =>
                      typeof delta.insert !== "string" ||
                      (delta.attributes && Object.keys(delta.attributes).length)
                  )
              ) {
                throw new Error("bad inline text");
              }
              return x.toString();
            })
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
      (doc) => {
        const fragment = element(doc).get("text");
        if (!(fragment instanceof YXmlFragment)) {
          throw new Error("fixture");
        }
        const paragraph = fragment.get(0);
        if (!(paragraph instanceof YXmlElement)) {
          throw new Error("fixture");
        }
        paragraph.setAttribute("onclick", "x");
      },
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

describe("editor model", () => {
  test("slide, element, group and batch geometry operations retain IDs and validate atomically", () => {
    const deck = new Deck(new YDoc(), codec);
    deck.addSlide(slide("s"));
    deck.duplicateElement("s", "se", "copy", "a1");
    deck.updateElements("s", {
      copy: { props: { h: "50", w: "100", x: "20", y: "80" } },
      se: { props: { h: "50", rotate: "45", w: "100", x: "20", y: "30" } },
    });
    deck.groupElements(
      "s",
      {
        id: "g",
        order: "a0",
        parent: "s",
        props: {},
        style: {},
        type: "group",
      },
      ["se", "copy"]
    );
    expect(
      deck.read("s").slide.elements.filter((e) => e.parent === "g")
    ).toHaveLength(2);
    const baseline = YencodeStateAsUpdate(deck.doc);
    expect(() => deck.moveElement("s", "g", "g", null, null)).toThrow("group");
    expect(() =>
      deck.updateElements("s", { copy: { props: { w: "-1" } } })
    ).toThrow("prop-w");
    expect(YencodeStateAsUpdate(deck.doc)).toEqual(baseline);
    deck.moveElement("s", "copy", "g", null, "se");
    deck.duplicateSlide("s", "t", "a1", { copy: "tc", g: "tg", se: "te" });
    expect(
      deck.read("t").slide.elements.find((e) => e.id === "te")?.parent
    ).toBe("tg");
    deck.ungroupElements("s", "g");
    expect(deck.read("s").slide.elements.every((e) => e.parent === "s")).toBe(
      true
    );
    deck.deleteElement("t", "tg");
    expect(deck.read("t").slide.elements).toEqual([]);
    deck.deleteElement("s", "copy");
    expect(deck.read("s").slide.elements).toHaveLength(1);
    deck.deleteSlide("t");
    expect(deck.ids()).toEqual(["s"]);
    deck.validate();
  });
  test("theme tokens and sections have per-key Yjs storage", () => {
    const deck = new Deck(new YDoc(), codec);
    deck.addSlide(slide("s"));
    deck.setTitle("My deck");
    deck.setTheme({
      colors: { accent: "#123456" },
      fonts: { body: "Arial" },
      sizes: { body: "16px" },
    });
    deck.setSection({ id: "intro", order: "a0", title: "Introduction" });
    deck.updateSlide("s", { section: "intro" });
    deck.setElementKey("s", "se", "style", "font-family", "Arial");
    const baseline = YencodeStateAsUpdate(deck.doc);
    expect(() =>
      deck.setTheme({ colors: {}, fonts: { body: "Other" }, sizes: {} })
    ).toThrow("font");
    expect(() =>
      deck.setTheme({ colors: { bad: "#12345" }, fonts: {}, sizes: {} })
    ).toThrow("/meta/theme/colors/bad");
    expect(() =>
      deck.setTheme({ colors: {}, fonts: { bad: "var(--font)" }, sizes: {} })
    ).toThrow("fonts/bad");
    expect(YencodeStateAsUpdate(deck.doc)).toEqual(baseline);
    const other = new Deck(replica(deck.doc), codec);
    deck.setTheme({ ...deck.theme(), colors: { accent: "#f00" } });
    other.setTheme({ ...other.theme(), sizes: { body: "20px" } });
    sync(deck.doc, other.doc);
    expect(deck.theme()).toEqual({
      colors: { accent: "#f00" },
      fonts: { body: "Arial" },
      sizes: { body: "20px" },
    });
    expect(deck.sections()).toEqual([
      { id: "intro", order: "a0", title: "Introduction" },
    ]);
    deck.deleteSection("intro");
    expect(deck.read("s").slide.section).toBeUndefined();
    expect(() => deck.updateSlide("s", { section: "missing" })).toThrow(
      "section"
    );
    deck.validate();
  });
  test("table cells and text are real independent XmlFragments", () => {
    const deck = new Deck(new YDoc(), codec);
    const s = slide("s");
    s.elements.push(table("t", "s", "2", "2"));
    deck.addSlide(s);
    deck.setCell("s", "t", "0:0", paragraphs("one"));
    deck.setCell("s", "t", "0:1", paragraphs("two"));
    const other = new Deck(replica(deck.doc), codec);
    replaceText(deck.cellFragment("s", "t", "0:0"), "left");
    replaceText(other.cellFragment("s", "t", "0:1"), "right");
    replaceText(deck.textFragment("s", "se"), "updated");
    deck.applyUpdate(YencodeStateAsUpdate(other.doc));
    other.applyUpdate(YencodeStateAsUpdate(deck.doc));
    const result = deck.read("s").slide;
    expect(result.elements.find((e) => e.id === "t")?.cells).toEqual({
      "0:0": paragraphs("left"),
      "0:1": paragraphs("right"),
    });
    expect(result.elements.find((e) => e.id === "se")?.text).toEqual(
      paragraphs("updated")
    );
    expect(deck.cellFragment("s", "t", "1:1")).toBeInstanceOf(YXmlFragment);
    const html = serializeSlide(deck.read("s").slide, codec);
    expect(parseSlide(html, codec)).toEqual(deck.read("s").slide);
    const baseline = YencodeStateAsUpdate(deck.doc);
    expect(() => deck.setCell("s", "t", "2:0", paragraphs("outside"))).toThrow(
      "outside"
    );
    expect(() => deck.setCell("s", "t", "00:0", [])).toThrow("cell key");
    expect(() =>
      deck.updateElement("s", "t", { props: { cols: "1", rows: "1" } })
    ).toThrow("outside");
    expect(YencodeStateAsUpdate(deck.doc)).toEqual(baseline);
  });
  test("images require artifact ownership as well as a safe canonical local path", () => {
    const s = slide("s");
    s.elements = [
      {
        id: "image",
        order: "a0",
        parent: "s",
        props: { src: "/files/owned/image" },
        style: {},
        type: "image",
      },
    ];
    expect(() => new Deck(new YDoc(), codec).addSlide(s)).toThrow("belong");
    const deck = new Deck(new YDoc(), codec, {
      ownsBlob: (path) => path === "/files/owned/image",
    });
    deck.addSlide(s);
    for (const src of [
      "https://evil.test/x",
      "javascript:alert(1)",
      "//evil.test/x",
      "/files/../secret",
      "/files/owned/%2f",
      "/files/owned/image?x",
      "/files//image",
      "/files/other/image",
    ]) {
      expect(() =>
        deck.setElementKey("s", "image", "props", "src", src)
      ).toThrow();
    }
    deck.validate();
  });
});

describe("strict grammar and bounds", () => {
  test("malformed HTML, unsupported constructs and lossy codecs cannot enter", () => {
    const html = serializeSlide(slide("s"), codec);
    for (const bad of [
      html.replace("<slide ", '<slide id="extra" '),
      html.replace("<p>", "<![CDATA[hidden]]><p>"),
      html.replace("<p>", "<?unsafe x?><p>"),
      html.replace("hello", "&unknown;"),
      html.replace('style-color="#000"', 'style-color="#12345"'),
      html.replace('order="a0"', 'order="zz"'),
      html.replace('parent="s"', 'parent="missing"'),
      html.replace("<p>", '<p onclick="x">'),
      html.replace("<notes>", '<notes src="x">'),
      html.replace("</slide>", "</slide><slide></slide>"),
      html.replace("hello", `${"<p>".repeat(20)}deep${"</p>".repeat(20)}`),
    ]) {
      expect(() => parseSlide(bad, codec)).toThrow("/");
    }
    const lossy: RichTextCodec = {
      parse() {
        /* Deliberately drops unknown data. */
      },
      serialize() {
        return [];
      },
    };
    expect(() => parseSlide(html, lossy)).toThrow("lossy");
    const unsafe = slide("s");
    first(unsafe.elements).text = [
      { attrs: {}, children: ["x"], tag: "script" },
    ];
    expect(() => serializeSlide(unsafe, codec)).toThrow("rich text");
    const escaped = slide("s");
    escaped.notes = "&".repeat(450_000);
    expect(() => new Deck(new YDoc(), codec).addSlide(escaped)).toThrow(
      "HTML size"
    );
    const large = slide("s");
    large.notes = "𐐀".repeat(500_001);
    expect(() => serializeSlide(large, codec)).toThrow("size");
  });
  test("slide, element, group, table and text limits apply to local edits and restores", () => {
    const deck = new Deck(new YDoc(), codec);
    const s = slide("s");
    s.elements = Array.from({ length: 200 }, (_, i) => ({
      ...first(s.elements),
      id: `e${i}`,
    }));
    deck.addSlide(s);
    expect(() =>
      deck.addElement("s", { ...first(s.elements), id: "overflow" })
    ).toThrow("limit");
    const groupSlide = slide("gslide");
    groupSlide.elements = [
      {
        id: "group",
        order: "a0",
        parent: "gslide",
        props: {},
        style: {},
        type: "group",
      },
      ...Array.from({ length: 25 }, (_, i) => ({
        ...first(slide("gslide").elements),
        id: `g${i}`,
        parent: "group",
      })),
    ];
    expect(() => deck.addSlide(groupSlide)).toThrow("pinned child");
    const deep = slide("deep");
    deep.elements = Array.from({ length: 18 }, (_, i) => ({
      id: `g${i}`,
      order: "a0",
      parent: i === 0 ? "deep" : `g${i - 1}`,
      props: {},
      style: {},
      type: "group",
    }));
    expect(() => deck.addSlide(deep)).toThrow("depth");
    const tables = new Deck(new YDoc(), codec);
    const ts = slide("tables");
    ts.elements = [table("t", "tables", "40", "100")];
    tables.addSlide(ts);
    const more = slide("more");
    more.elements = [table("extra", "more", "1", "1")];
    expect(() => tables.addSlide(more)).toThrow("cell limit");
    const badTable = slide("bad");
    badTable.elements = [table("badtable", "bad", "41", "100")];
    expect(() => tables.addSlide(badTable)).toThrow("cell limit");
    const all = new Deck(new YDoc(), codec);
    const empty = slide("s0");
    empty.elements = [];
    all.addSlide(empty);
    // Construct a valid large checkpoint fixture, then exercise the actual 500th/501st admissions.
    all.doc.transact(() => {
      const slides = all.doc.getMap("slides");
      for (let i = 1; i < 499; i += 1) {
        slides.set(`s${i}`, fieldMap(slides, "s0").clone());
      }
    });
    all.addSlide({ ...empty, id: "s499" });
    const baseline = YencodeStateAsUpdate(all.doc);
    expect(() => all.addSlide(slide("overflow"))).toThrow("limit");
    const remote = replica(all.doc);
    remote
      .getMap("slides")
      .set("extra", fieldMap(remote.getMap("slides"), "s0").clone());
    expect(() => all.applyUpdate(YencodeStateAsUpdate(remote))).toThrow(
      "limit"
    );
    expect(() => all.restore(YencodeStateAsUpdate(remote))).toThrow("limit");
    expect(YencodeStateAsUpdate(all.doc)).toEqual(baseline);
    expect(() =>
      all.applyUpdate(new Uint8Array(LIMITS.updateBytes + 1))
    ).toThrow("size");
    expect(() => all.restore(new Uint8Array(LIMITS.updateBytes + 1))).toThrow(
      "size"
    );
  });
  test("concurrent valid additions exceeding a limit are refused by the authority", () => {
    const authority = new Deck(new YDoc(), codec);
    const s = slide("s");
    s.elements = Array.from({ length: 199 }, (_, i) => ({
      ...first(s.elements),
      id: `e${i}`,
    }));
    authority.addSlide(s);
    const a = new Deck(replica(authority.doc), codec),
      b = new Deck(replica(authority.doc), codec);
    a.addElement("s", { ...first(s.elements), id: "a" });
    b.addElement("s", { ...first(s.elements), id: "b" });
    authority.applyUpdate(YencodeStateAsUpdate(a.doc));
    const accepted = YencodeStateAsUpdate(authority.doc);
    expect(() => authority.applyUpdate(YencodeStateAsUpdate(b.doc))).toThrow(
      "limit"
    );
    expect(YencodeStateAsUpdate(authority.doc)).toEqual(accepted);
  });
});

function paragraphs(text: string): Node[] {
  return [{ attrs: {}, children: [text], tag: "p" }];
}
function table(
  id: string,
  parent: string,
  rows: string,
  cols: string
): import("./index").ElementData {
  return {
    cells: {},
    id,
    order: "a1",
    parent,
    props: { cols, rows },
    style: {},
    type: "table",
  };
}
function replaceText(fragment: YXmlFragment, value: string) {
  fragment.delete(0, fragment.length);
  codec.parse(paragraphs(value), fragment);
}

test("shared link URL grammar rejects executable schemes, controls, credentials and protocol-relative links", () => {
  for (const url of [
    "https://example.test/path?q=1",
    "http://example.test",
    "mailto:person@example.test",
    "/workspaces/ours/live/id",
  ]) {
    expect(() => validateLinkUrl(url)).not.toThrow();
  }
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,x",
    "//evil.test/x",
    "/\\evil.test",
    " https://example.test",
    "https://user:password@example.test",
    "mailto:x@example.test%0d%0abcc:other@example.test",
    "https://example.test/%zz",
    "https://example.test/\n",
  ]) {
    expect(() => validateLinkUrl(url, "/p/a/@href")).toThrow("/p/a/@href");
  }
});

test("agent layout patches preserve unrelated human keys and detect layout ABA", () => {
  const deck = new Deck(new YDoc(), codec);
  deck.addSlide(slide("s"));
  const observed = deck.read("s"),
    desired = structuredClone(observed.slide);
  desired.layout.direction = "column";
  deck.updateSlide("s", { layout: { display: "flex", gap: "12px" } });
  expect(
    deck.write("s", serializeSlide(desired, codec), observed).applied
  ).toEqual(["s:layout:direction"]);
  expect(deck.read("s").slide.layout).toEqual({
    direction: "column",
    display: "flex",
    gap: "12px",
  });
  const next = deck.read("s"),
    wanted = structuredClone(next.slide);
  wanted.layout.gap = "30px";
  deck.updateSlide("s", { layout: { ...next.slide.layout, gap: "20px" } });
  deck.updateSlide("s", { layout: next.slide.layout });
  expect(deck.write("s", serializeSlide(wanted, codec), next).skipped).toEqual([
    { id: "s", reason: "layout:gap changed since read" },
  ]);
});

test("shape, icon, connector and flow grammar roundtrip; group duplication remaps references", () => {
  const deck = new Deck(new YDoc(), codec);
  const s = slide("s");
  s.layout = {
    "align-items": "center",
    display: "grid",
    "grid-template-columns": "repeat(2, 1fr)",
    padding: "20px",
  };
  s.elements.push({
    id: "shape",
    order: "a1",
    parent: "s",
    props: {
      "flex-grow": "1",
      flow: "flow",
      "grid-column": "span 2",
      shape: "ellipse",
    },
    style: { "background-color": "#f00", "border-radius": "4px" },
    type: "shape",
  });
  s.elements.push({
    id: "icon",
    order: "a2",
    parent: "s",
    props: { icon: "arrow-right" },
    style: {},
    type: "icon",
  });
  s.elements.push({
    id: "edge",
    order: "a3",
    parent: "s",
    props: { from: "shape", "from-anchor": "right", to: "icon" },
    style: {},
    type: "connector",
  });
  deck.addSlide(s);
  deck.groupElements(
    "s",
    { id: "g", order: "a0", parent: "s", props: {}, style: {}, type: "group" },
    ["shape", "icon", "edge"]
  );
  deck.duplicateElement("s", "g", "gc", "a4", {
    edge: "ec",
    icon: "ic",
    shape: "sc",
  });
  expect(
    deck.read("s").slide.elements.find((e) => e.id === "ec")?.props.from
  ).toBe("sc");
  expect(
    parseSlide(serializeSlide(deck.read("s").slide, codec), codec)
  ).toEqual(deck.read("s").slide);
  deck.deleteElement("s", "shape");
  expect(deck.read("s").slide.elements.some((e) => e.id === "edge")).toBe(
    false
  );
  expect(() =>
    deck.setElementKey("s", "sc", "props", "shape", "url(x)")
  ).toThrow("prop-shape");
  expect(() =>
    deck.setElementKey("s", "ic", "props", "src", "/files/x")
  ).toThrow("only allowed");
});

test("notes embeds, hidden root arrays and deep XML cannot cross ingress", () => {
  const deck = new Deck(new YDoc(), codec);
  deck.addSlide(slide("s"));
  const baseline = YencodeStateAsUpdate(deck.doc);
  const embedded = replica(deck.doc);
  const notes = scene(embedded).get("notes");
  if (!(notes instanceof YText)) {
    throw new Error("fixture");
  }
  notes.insertEmbed(0, { html: "<script>x</script>" });
  expect(() => deck.applyUpdate(YencodeStateAsUpdate(embedded))).toThrow(
    "notes"
  );
  const hidden = new YDoc();
  hidden.getArray("slides").insert(0, ["hidden"]);
  expect(() => deck.applyUpdate(YencodeStateAsUpdate(hidden))).toThrow("root");
  const deep = replica(deck.doc);
  const fragment = element(deep).get("text");
  if (!(fragment instanceof YXmlFragment)) {
    throw new Error("fixture");
  }
  const nodes: YXmlElement[] = Array.from(
    { length: 20 },
    () => new YXmlElement("p")
  );
  fragment.insert(0, [first(nodes)]);
  for (let i = 1; i < nodes.length; i += 1) {
    at(nodes, i - 1).insert(0, [at(nodes, i)]);
  }
  expect(() => deck.applyUpdate(YencodeStateAsUpdate(deep))).toThrow("depth");
  expect(YencodeStateAsUpdate(deck.doc)).toEqual(baseline);
});

test("rich-text and notes ABA are guarded; token-only HTML writes retain untouched fragments", () => {
  const deck = new Deck(new YDoc(), codec);
  deck.addSlide(slide("s"));
  const observed = deck.read("s"),
    desired = structuredClone(observed.slide);
  first(desired.elements).text = paragraphs("agent");
  desired.notes = "agent notes";
  replaceText(deck.textFragment("s", "se"), "human");
  replaceText(deck.textFragment("s", "se"), "hello");
  deck.updateSlide("s", { notes: "human notes" });
  deck.updateSlide("s", { notes: "notes" });
  const result = deck.write(
    "s",
    serializeSlide(desired, codec),
    observed.revision
  );
  expect(result.skipped).toEqual([
    { id: "se", reason: "changed since read" },
    { id: "s", reason: "notes changed since read" },
  ]);
  const read = deck.readHtml("s"),
    fragment = deck.textFragment("s", "se"),
    paragraph = fragment.get(0);
  expect(
    deck.write(
      "s",
      read.html.replace('style-color="#000"', 'style-color="#f00"'),
      read.revision
    ).applied
  ).toEqual(["se"]);
  expect(deck.textFragment("s", "se")).toBe(fragment);
  expect(fragment.get(0)).toBe(paragraph);
  expect(() => deck.write("s", read.html, "invented-token")).toThrow(
    "observation"
  );
});

test("prototype-named attributes are rejected at each HTML boundary", () => {
  const html = serializeSlide(slide("s"), codec);
  for (const tag of ["slide", "element", "p"]) {
    expect(() =>
      parseSlide(html.replace(`<${tag}`, `<${tag} __proto__="x"`), codec)
    ).toThrow();
  }
});

test("XML-illegal strings cannot enter local scenes, remote updates or restores", () => {
  const deck = new Deck(new YDoc(), codec);
  deck.addSlide(slide("s"));
  const original = deck.readHtml("s").html;
  for (const invalid of ["\u0000", "\u0001", "\ud800", "\ufffe"]) {
    expect(() => deck.addSlide({ ...slide("bad"), notes: invalid })).toThrow();
    expect(() => deck.updateSlide("s", { notes: invalid })).toThrow();
    const textSlide = slide("text");
    const [textElement] = textSlide.elements;
    if (!textElement) {
      throw new Error("missing element");
    }
    textElement.text = [{ attrs: {}, children: [invalid], tag: "p" }];
    expect(() => deck.addSlide(textSlide)).toThrow();
    // Yjs UTF-8 encoding normalizes lone surrogates to U+FFFD.
    if (invalid === "\ud800") {
      continue;
    }
    const remote = replica(deck.doc);
    const notes = remote.getMap<YMap<unknown>>("slides").get("s")?.get("notes");
    if (!(notes instanceof YText)) {
      throw new Error("missing notes");
    }
    notes.insert(0, invalid);
    expect(() => deck.applyUpdate(YencodeStateAsUpdate(remote))).toThrow();
    expect(() => deck.restore(YencodeStateAsUpdate(remote))).toThrow();
    expect(deck.readHtml("s").html).toBe(original);
  }
  deck.updateSlide("s", { notes: "Valid \t\nemoji 🦀 and & < >" });
  expect(parseSlide(deck.readHtml("s").html, codec).notes).toBe(
    "Valid \t\nemoji 🦀 and & < >"
  );
});
