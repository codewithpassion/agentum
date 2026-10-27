/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Tests assert validated but runtime-indexed scene dictionaries. */
import { expect, test } from "bun:test";
import { Doc, encodeStateAsUpdate, UndoManager } from "yjs";
import { Deck, type ElementData, parseSlide, serializeSlide } from "./index";
import { richTextCodec } from "./rich-text";

const source = `artifact:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:${"a".repeat(64)}:pages/chart.html`;
function fixture(extraSources: string[] = []) {
  const deck = new Deck(new Doc(), richTextCodec, {
    ownsBlob: (path) => path === source || extraSources.includes(path),
  });
  deck.addSlide({
    background: "#fff",
    duration: "0",
    elements: [
      {
        id: "embed",
        order: "a0",
        parent: "s",
        props: { h: "200", src: source, w: "400", x: "0", y: "0" },
        style: {},
        type: "embed",
      },
    ],
    id: "s",
    layout: {},
    notes: "",
    order: "a0",
    transition: "none",
  });
  return deck;
}
test("embed constrained HTML round trips identity and refuses raw or unsupported sources atomically", () => {
  const deck = fixture();
  const { html } = deck.readHtml("s");
  expect(serializeSlide(parseSlide(html, richTextCodec), richTextCodec)).toBe(
    html
  );
  for (const src of [
    "https://evil.test/",
    "//evil.test",
    "data:text/html,hi",
    "javascript:alert(1)",
    "/files/html",
    source.replace("pages/chart.html", "../chart.html"),
    source.replace("chart.html", "chart.svg"),
    source.replace("a".repeat(64), "b".repeat(64)),
  ]) {
    const before = encodeStateAsUpdate(deck.doc);
    expect(() =>
      deck.setElementKey("s", "embed", "props", "src", src)
    ).toThrow();
    expect(encodeStateAsUpdate(deck.doc)).toEqual(before);
  }
  expect(() => deck.updateElement("s", "embed", { props: {} })).toThrow();
});
test("embed per-key guarded merges preserve geometry, same-key ABA, undo and checkpoint restore", () => {
  const deck = fixture();
  const checkpoint = encodeStateAsUpdate(deck.doc);
  const undo = new UndoManager(deck.doc.getMap("slides"), {
    captureTimeout: 0,
  });
  const observed = deck.readHtml("s");
  deck.setElementKey("s", "embed", "props", "x", "35");
  const desired = parseSlide(observed.html, richTextCodec);
  const e = desired.elements[0] as ElementData;
  e.props.y = "42";
  const result = deck.write(
    "s",
    serializeSlide(desired, richTextCodec),
    observed.revision
  );
  expect(result.skipped).toEqual([]);
  expect(deck.read("s").slide.elements[0]?.props).toMatchObject({
    src: source,
    x: "35",
    y: "42",
  });
  undo.undo();
  expect(deck.read("s").slide.elements[0]?.props.y).toBe("0");
  const aba = deck.readHtml("s");
  deck.setElementKey("s", "embed", "props", "x", "99");
  deck.setElementKey("s", "embed", "props", "x", "35");
  expect(
    deck.write(
      "s",
      aba.html.replace('prop-x="35"', 'prop-x="51"'),
      aba.revision
    ).skipped
  ).toContainEqual({ id: "embed", reason: "props:x changed since read" });
  deck.restore(checkpoint);
  expect(deck.read("s").slide.elements[0]?.props.x).toBe("0");
  expect(() => deck.write("s", aba.html, aba.revision)).toThrow();
  undo.destroy();
});
test("embed binary ingress and restored checkpoints require exact host ownership", () => {
  const deck = fixture();
  const denied = new Deck(new Doc(), richTextCodec, { ownsBlob: () => false });
  expect(() => denied.applyUpdate(encodeStateAsUpdate(deck.doc))).toThrow(
    "belong"
  );
  expect(denied.ids()).toEqual([]);
  expect(() => denied.restore(encodeStateAsUpdate(deck.doc))).toThrow("belong");
});

test("embed count limits reject candidate scenes without partial changes", () => {
  const deck = fixture();
  const { slide } = deck.read("s");
  const original = slide.elements[0] as ElementData;
  slide.elements = Array.from({ length: 17 }, (_, index) => ({
    ...structuredClone(original),
    id: `embed${index}`,
    order: `a${index.toString(36)}`,
  }));
  const before = encodeStateAsUpdate(deck.doc);
  expect(() => deck.updateSlide("s", slide)).toThrow("embed limit");
  expect(encodeStateAsUpdate(deck.doc)).toEqual(before);
});

test("contested source identity is skipped while independent embed geometry applies", () => {
  const other = source.replace("chart.html", "other.html");
  const wanted = source.replace("chart.html", "wanted.html");
  const deck = fixture([other, wanted]);
  const observed = deck.readHtml("s");
  deck.setElementKey("s", "embed", "props", "src", other);
  const result = deck.write(
    "s",
    observed.html.replace(source, wanted).replace('prop-x="0"', 'prop-x="77"'),
    observed.revision
  );
  expect(result.skipped).toContainEqual({
    id: "embed",
    reason: "props:src changed since read",
  });
  expect(deck.read("s").slide.elements[0]?.props).toMatchObject({
    src: other,
    x: "77",
  });
});
