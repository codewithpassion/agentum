import { expect, test } from "bun:test";
import { schema, updateYFragment } from "@repo/live-doc/rich-text";
import {
  applyUpdate,
  createAbsolutePositionFromRelativePosition,
  createRelativePositionFromTypeIndex,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  XmlElement,
  type XmlText,
} from "yjs";
import { node, rich, slide } from "./fixtures/rich-text";
import { Deck, type Node, parseSlide, serializeSlide } from "./index";
import { richTextCodec as codec } from "./rich-text";

test("real shared schema/Yjs rich text, lists, empty paragraphs, Unicode and table cells round trip", () => {
  const doc = new Doc();
  const fragment = doc.getXmlFragment("text");
  codec.parse(rich, fragment);
  expect(codec.serialize(fragment)).toEqual(rich);
  expect((fragment.get(0) as XmlElement).nodeName).toBe("paragraph");
  const replica = new Doc();
  applyUpdate(replica, encodeStateAsUpdate(doc));
  expect(codec.serialize(replica.getXmlFragment("text"))).toEqual(rich);
  const data = slide();
  const html = serializeSlide(data, codec);
  expect(parseSlide(html, codec)).toEqual(data);
  const deck = new Deck(new Doc(), codec);
  deck.addSlide(data);
  const expected = {
    ...data,
    elements: [...data.elements].sort((a, b) => a.id.localeCompare(b.id)),
  };
  expect(deck.read("s").slide).toEqual(expected);
  const restored = new Deck(new Doc(), codec);
  restored.restore(encodeStateAsUpdate(deck.doc));
  expect(restored.read("s").slide).toEqual(expected);
});

test("direct codec reconciliation keeps XML/text identity, IDs and relative positions", () => {
  const doc = new Doc();
  const fragment = doc.getXmlFragment("text");
  const before = [
    node("p", ["hello"], { "data-id": "stable" }),
    node("p", ["untouched"]),
  ];
  codec.parse(before, fragment);
  const paragraph = fragment.get(0) as XmlElement;
  const text = paragraph.get(0) as XmlText;
  const second = fragment.get(1);
  const position = createRelativePositionFromTypeIndex(text, 2);
  const vector = encodeStateVector(doc);
  codec.parse(before, fragment);
  expect(encodeStateVector(doc)).toEqual(vector);
  codec.parse(
    [node("p", ["hello!"], { "data-id": "stable" }), before[1] as Node],
    fragment
  );
  expect(fragment.get(0)).toBe(paragraph);
  expect(paragraph.get(0)).toBe(text);
  expect(fragment.get(1)).toBe(second);
  expect(createAbsolutePositionFromRelativePosition(position, doc)?.type).toBe(
    text
  );
  expect(codec.serialize(fragment)[0]).toEqual(
    node("p", ["hello!"], { "data-id": "stable" })
  );
});

test("uses document schema output rather than a parallel XML convention", () => {
  const doc = new Doc();
  const fragment = doc.getXmlFragment("text");
  const pm = schema.node("doc", null, [
    schema.node("paragraph", { id: "shared" }, [
      schema.text("linked", [schema.mark("link", { href: "/safe" })]),
    ]),
  ]);
  updateYFragment(doc, fragment, pm, {
    isOMark: new Map(),
    mapping: new Map(),
  });
  expect(codec.serialize(fragment)).toEqual([
    node(
      "p",
      [
        node("a", ["linked"], {
          href: "/safe",
          rel: "noopener noreferrer",
          target: "_blank",
        }),
      ],
      { "data-id": "shared" }
    ),
  ]);
});

test("HTML-tree rejection is atomic, including unsupported document nodes and links", () => {
  const doc = new Doc();
  const fragment = doc.getXmlFragment("text");
  codec.parse(rich, fragment);
  const bad = [
    node("script", ["alert(1)"]),
    node("h1", ["heading"]),
    node("img", [], { src: "/files/x" }),
    node("p", [node("iframe")]),
    node("p", ["x"], { onclick: "x" }),
    node("p", [node("strong", ["x"], { evil: "yes" })]),
    node("p", [node("span", ["x"], { style: "color: red" })]),
    node("p", [
      node("a", ["x"], {
        href: "javascript:alert(1)",
        rel: "noopener noreferrer",
        target: "_blank",
      }),
    ]),
    node("ul", [node("p", ["bad structure"])]),
    node("ol", [node("li", [node("p")])], { start: "0" }),
  ];
  for (const input of bad) {
    const bytes = encodeStateAsUpdate(doc);
    let events = 0;
    const onUpdate = () => {
      events += 1;
    };
    doc.on("update", onUpdate);
    expect(() => codec.parse([input], fragment)).toThrow();
    expect(encodeStateAsUpdate(doc)).toEqual(bytes);
    expect(events).toBe(0);
    doc.off("update", onUpdate);
  }
});

function rawAttack(change: (text: XmlText, paragraph: XmlElement) => void) {
  const deck = new Deck(new Doc(), codec);
  deck.addSlide(slide());
  const replica = new Doc();
  applyUpdate(replica, encodeStateAsUpdate(deck.doc));
  const shadow = new Deck(replica, codec);
  const fragment = shadow.textFragment("s", "text");
  const paragraph = fragment.get(0) as XmlElement;
  const text = paragraph.get(0) as XmlText;
  const vector = encodeStateVector(deck.doc);
  const bytes = encodeStateAsUpdate(deck.doc);
  change(text, paragraph);
  let updates = 0;
  deck.doc.on("update", () => {
    updates += 1;
  });
  // biome-ignore lint/suspicious/noMisplacedAssertion: Called synchronously inside adversarial test.
  expect(() =>
    deck.applyUpdate(encodeStateAsUpdate(replica, vector))
  ).toThrow();
  // biome-ignore lint/suspicious/noMisplacedAssertion: Called synchronously inside adversarial test.
  expect(encodeStateAsUpdate(deck.doc)).toEqual(bytes);
  // biome-ignore lint/suspicious/noMisplacedAssertion: Called synchronously inside adversarial test.
  expect(updates).toBe(0);
  // biome-ignore lint/suspicious/noMisplacedAssertion: Called synchronously inside adversarial test.
  expect(() => codec.serialize(fragment)).toThrow();
  const restored = new Deck(new Doc(), codec);
  // biome-ignore lint/suspicious/noMisplacedAssertion: Called synchronously inside adversarial test.
  expect(() => restored.restore(encodeStateAsUpdate(replica))).toThrow();
}

test("raw hostile binary marks and attributes cannot disappear through PM projection", () => {
  const markValues: Record<string, unknown>[] = [
    { unknown: {} },
    { bold: { evil: "yes" } },
    { bold: true },
    { bold: [] },
    { bold: {}, "bold--12345678": {} },
    { "unknown--12345678": {} },
    {
      link: {
        href: "https://user:pass@example.com",
        rel: "noopener noreferrer",
        target: "_blank",
      },
    },
    {
      link: { href: "/%2fhost", rel: "noopener noreferrer", target: "_blank" },
    },
    {
      link: {
        evil: "yes",
        href: "https://example.com",
        rel: "noopener noreferrer",
        target: "_blank",
      },
    },
    {
      link: {
        href: "javascript:alert(1)",
        rel: "noopener noreferrer",
        target: "_blank",
      },
    },
    { textStyle: { color: "#3b82f6", evil: "yes" } },
    { textStyle: { color: "red" } },
    { "unknown--12345678": {} },
  ];
  for (const values of markValues) {
    rawAttack((text) => text.format(0, 1, values));
  }
  rawAttack((_text, paragraph) => paragraph.setAttribute("onclick", "evil"));
  rawAttack((text) => text.setAttribute("evil", "hidden"));
  rawAttack((text) => text.insertEmbed(0, { evil: "embed" }));
  rawAttack((_text, paragraph) =>
    paragraph.insert(0, [new XmlElement("script")])
  );
});

test("binary concurrent typing retains original Yjs IDs and formatting", () => {
  const deck = new Deck(new Doc(), codec);
  deck.addSlide(slide());
  const replica = new Doc();
  applyUpdate(replica, encodeStateAsUpdate(deck.doc));
  const other = new Deck(replica, codec);
  const text = (other.textFragment("s", "text").get(0) as XmlElement).get(
    0
  ) as XmlText;
  const id = text._item?.id;
  text.insert(0, "human ", { bold: {} });
  deck.applyUpdate(encodeStateAsUpdate(replica, encodeStateVector(deck.doc)));
  const actual = (deck.textFragment("s", "text").get(0) as XmlElement).get(
    0
  ) as XmlText;
  expect(actual._item?.id).toEqual(id);
  expect(actual.toDelta()[0]?.attributes?.bold).toEqual({});
  expect(codec.serialize(deck.textFragment("s", "text"))[0]).toEqual(
    codec.serialize(other.textFragment("s", "text"))[0]
  );
});

test("strict canonical subset rejects malformed structures, IDs, XML text and mark combinations before mutation", () => {
  const doc = new Doc();
  const fragment = doc.getXmlFragment("text");
  codec.parse([node("p", ["original"])], fragment);
  const bad: (Node | string)[][] = [
    ["root inline"],
    [node("p", ["\u0000"])],
    [node("p", ["\ud800"])],
    [node("p", [node("strong", [node("strong", ["duplicate"])])])],
    [node("p", [node("code", [node("strong", ["excluded"])])])],
    [
      node("p", [
        node("span", ["x"], { style: "color: #3b82f6; background: url(evil)" }),
      ]),
    ],
    [
      node("p", [], { "data-id": "duplicate" }),
      node("p", [], { "data-id": "duplicate" }),
    ],
    [
      node("ul", [
        node("li", [node("p")], {
          "data-checked": "false",
          "data-type": "taskItem",
        }),
      ]),
    ],
    [
      node(
        "ul",
        [
          node("li", [node("p")], {
            "data-checked": "truthy",
            "data-type": "taskItem",
          }),
        ],
        { "data-type": "taskList" }
      ),
    ],
    [node("p", ["a", "b"])],
    [node("p", [node("strong")])],
  ];
  for (const input of bad) {
    const bytes = encodeStateAsUpdate(doc);
    expect(() => codec.parse(input, fragment)).toThrow();
    expect(encodeStateAsUpdate(doc)).toEqual(bytes);
  }
});

test("unsupported shared document blocks and attributes fail closed in real Yjs", () => {
  for (const content of [
    schema.node("heading", { level: 1 }, [schema.text("heading")]),
    schema.node("blockquote", null, [schema.node("paragraph")]),
    schema.node("paragraph", null, [
      schema.node("mention", { label: "X", value: "x" }),
    ]),
    schema.node("orderedList", { type: "a" }, [
      schema.node("listItem", null, [schema.node("paragraph")]),
    ]),
  ]) {
    const doc = new Doc();
    const fragment = doc.getXmlFragment("text");
    updateYFragment(doc, fragment, schema.node("doc", null, [content]), {
      isOMark: new Map(),
      mapping: new Map(),
    });
    const bytes = encodeStateAsUpdate(doc);
    expect(() => codec.serialize(fragment)).toThrow();
    expect(encodeStateAsUpdate(doc)).toEqual(bytes);
  }
});

test("independent rich-text and table-cell edits converge with original Yjs types", () => {
  const left = new Deck(new Doc(), codec);
  left.addSlide(slide());
  const replica = new Doc();
  applyUpdate(replica, encodeStateAsUpdate(left.doc));
  const right = new Deck(replica, codec);
  const leftText = (left.textFragment("s", "text").get(0) as XmlElement).get(
    0
  ) as XmlText;
  const rightCell = (
    right.cellFragment("s", "table", "0:0").get(0) as XmlElement
  ).get(0) as XmlText;
  const leftId = leftText._item?.id;
  const cellId = rightCell._item?.id;
  leftText.insert(0, "left ", { bold: {} });
  rightCell.insert(0, "right ", { italic: {} });
  const leftUpdate = encodeStateAsUpdate(
    left.doc,
    encodeStateVector(right.doc)
  );
  const rightUpdate = encodeStateAsUpdate(
    right.doc,
    encodeStateVector(left.doc)
  );
  left.applyUpdate(rightUpdate);
  right.applyUpdate(leftUpdate);
  expect(left.read("s").slide).toEqual(right.read("s").slide);
  const mergedText = (right.textFragment("s", "text").get(0) as XmlElement).get(
    0
  ) as XmlText;
  const mergedCell = (
    left.cellFragment("s", "table", "0:0").get(0) as XmlElement
  ).get(0) as XmlText;
  expect(mergedText._item?.id).toEqual(leftId);
  expect(mergedCell._item?.id).toEqual(cellId);
  expect(mergedText.toDelta()[0]?.attributes?.bold).toEqual({});
  expect(mergedCell.toDelta()[0]?.attributes?.italic).toEqual({});
});

test("Unicode scalar samples survive production Yjs and HTML interchange unchanged", () => {
  // Cover every Unicode plane, combining text, RTL, line endings and XML boundary values.
  const samples = ["\t\n\r", "é שָׁלוֹם العربية", "<&>\"'", "\ud7ff\ue000\ufffd"];
  for (let plane = 1; plane <= 16; plane += 1) {
    samples.push(
      String.fromCodePoint(
        plane * 65_536,
        plane * 65_536 + 1234,
        plane * 65_536 + 65_535
      )
    );
  }
  for (const text of samples) {
    const data = slide();
    data.elements = [
      {
        id: "text",
        order: "a0",
        parent: "s",
        props: {},
        style: {},
        text: [node("p", [text])],
        type: "text",
      },
    ];
    const deck = new Deck(new Doc(), codec);
    deck.addSlide(data);
    expect(parseSlide(deck.readHtml("s").html, codec)).toEqual(data);
  }
});
