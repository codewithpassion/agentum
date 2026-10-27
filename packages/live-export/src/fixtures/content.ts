import { Deck, type SlideData } from "@repo/live-deck";
import { richTextCodec } from "@repo/live-deck/rich-text";
import { LiveDocument } from "@repo/live-doc";
import { zlibSync } from "fflate";
import { Doc, encodeStateAsUpdate } from "yjs";
import type { OwnAssets } from "../input";

// A complete one-pixel RGBA PNG generated with checked CRCs, not a fake asset.
function crc(bytes: Uint8Array) {
  let c = 0xff_ff_ff_ff;
  for (const b of bytes) {
    // biome-ignore lint/suspicious/noBitwiseOperators: Fixture PNG CRC-32.
    c ^= b;
    for (let i = 0; i < 8; i += 1) {
      // biome-ignore lint/suspicious/noBitwiseOperators: Fixture PNG CRC-32.
      c = (c >>> 1) ^ (c & 1 ? 0xed_b8_83_20 : 0);
    }
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Fixture PNG CRC-32.
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}
function chunk(name: string, data: Uint8Array) {
  const b = new Uint8Array(data.length + 12),
    v = new DataView(b.buffer);
  v.setUint32(0, data.length);
  b.set(new TextEncoder().encode(name), 4);
  b.set(data, 8);
  v.setUint32(b.length - 4, crc(b.subarray(4, b.length - 4)));
  return b;
}
export function pngFor(width: number, height: number, raw: Uint8Array) {
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  return new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk("IHDR", header),
    ...chunk("IDAT", zlibSync(raw, { level: 0 })),
    ...chunk("IEND", new Uint8Array()),
  ]);
}
export const png = pngFor(1, 1, new Uint8Array([0, 20, 100, 220, 255]));
export const assets: OwnAssets = {
  paths: new Set(["/files/image"]),
  read: async () => ({ bytes: png, mime: "image/png" }),
};
export function docFixture(extraParagraphs = 0) {
  const doc = new Doc(),
    live = new LiveDocument(doc, { ownBlobUrls: assets.paths });
  live.import(
    {
      json: {
        content: [
          {
            attrs: { level: 1 },
            content: [{ text: "Export <report> & résumé", type: "text" }],
            type: "heading",
          },
          {
            content: [
              { marks: [{ type: "bold" }], text: "Bold", type: "text" },
              {
                marks: [{ type: "italic" }, { type: "underline" }],
                text: " italic",
                type: "text",
              },
              { attrs: { label: "@Alice", value: "alice" }, type: "mention" },
              { attrs: { label: "Today", value: "2026-10-27" }, type: "date" },
            ],
            type: "paragraph",
          },
          {
            attrs: { start: 3 },
            content: [
              {
                content: [
                  {
                    content: [{ text: "Third", type: "text" }],
                    type: "paragraph",
                  },
                ],
                type: "listItem",
              },
            ],
            type: "orderedList",
          },
          {
            content: [
              {
                attrs: { checked: true },
                content: [
                  {
                    content: [{ text: "Done", type: "text" }],
                    type: "paragraph",
                  },
                ],
                type: "taskItem",
              },
            ],
            type: "taskList",
          },
          {
            content: [
              {
                content: [
                  {
                    attrs: { backgroundColor: "#3b82f6", colspan: 2 },
                    content: [
                      {
                        content: [{ text: "Header", type: "text" }],
                        type: "paragraph",
                      },
                    ],
                    type: "tableHeader",
                  },
                ],
                type: "tableRow",
              },
              {
                content: [
                  {
                    content: [
                      {
                        content: [{ text: "Cell A", type: "text" }],
                        type: "paragraph",
                      },
                    ],
                    type: "tableCell",
                  },
                  {
                    content: [
                      {
                        content: [{ text: "Cell B", type: "text" }],
                        type: "paragraph",
                      },
                    ],
                    type: "tableCell",
                  },
                ],
                type: "tableRow",
              },
            ],
            type: "table",
          },
          { attrs: { alt: "Safe image", src: "/files/image" }, type: "image" },
          {
            content: [{ text: "<script>alert(1)</script>", type: "text" }],
            type: "codeBlock",
          },
          { attrs: { intent: "Awaiting data" }, type: "pending" },
          ...Array.from({ length: extraParagraphs }, (_unused, index) => ({
            content: [
              {
                text: `Pagination paragraph ${index}: a representative line of document text.`,
                type: "text",
              },
            ],
            type: "paragraph",
          })),
        ],
        type: "doc",
      },
    },
    "fixture"
  );
  const result = encodeStateAsUpdate(doc);
  live.destroy();
  doc.destroy();
  return result;
}
export function deckFixture() {
  const doc = new Doc(),
    deck = new Deck(doc, richTextCodec, {
      ownsBlob: (p) => assets.paths.has(p),
    });
  deck.setTheme({
    colors: { accent: "#3b82f6" },
    fonts: { body: "Calibri" },
    sizes: { body: "24px" },
  });
  const slide: SlideData = {
    background: "#ffffff",
    duration: "100",
    elements: [
      {
        id: "t",
        order: "a0",
        parent: "s",
        props: { h: "100", rotate: "5", w: "600", x: "96", y: "48" },
        style: { color: "#3b82f6", "font-size": "32px" },
        text: [
          {
            attrs: {},
            children: [
              { attrs: {}, children: ["Deck title"], tag: "strong" },
              " Unicode 🛟",
            ],
            tag: "p",
          },
        ],
        type: "text",
      },
      {
        id: "shape",
        order: "a1",
        parent: "s",
        props: { h: "100", shape: "ellipse", w: "150", x: "50", y: "200" },
        style: { "background-color": "#3b82f6" },
        type: "shape",
      },
      {
        id: "img",
        order: "a2",
        parent: "s",
        props: {
          alt: "Pixel",
          h: "100",
          src: "/files/image",
          w: "100",
          x: "220",
          y: "200",
        },
        style: {},
        type: "image",
      },
      {
        cells: {
          "0:0": [{ attrs: {}, children: ["Cell 1"], tag: "p" }],
          "1:1": [{ attrs: {}, children: ["Cell 4"], tag: "p" }],
        },
        id: "table",
        order: "a3",
        parent: "s",
        props: { cols: "2", h: "200", rows: "2", w: "400", x: "400", y: "200" },
        style: {},
        type: "table",
      },
      {
        id: "icon",
        order: "a4",
        parent: "s",
        props: { h: "50", icon: "star", w: "50", x: "900", y: "300" },
        style: {},
        type: "icon",
      },
    ],
    id: "s",
    layout: { display: "flex" },
    notes: "Speaker notes <safe>",
    order: "a0",
    transition: "fade",
  };
  slide.elements.push(
    {
      id: "g",
      order: "a5",
      parent: "s",
      props: { h: "100", w: "200", x: "100", y: "400" },
      style: {},
      type: "group",
    },
    {
      id: "gc",
      order: "a0",
      parent: "g",
      props: { h: "40", w: "100", x: "10", y: "20" },
      style: {},
      text: [{ attrs: {}, children: ["Grouped"], tag: "p" }],
      type: "text",
    }
  );
  deck.addSlide(slide);
  deck.addSlide({
    ...slide,
    elements: [],
    id: "s2",
    notes: "Second slide",
    order: "a1",
    transition: "none",
  });
  const result = encodeStateAsUpdate(doc);
  deck.destroy();
  doc.destroy();
  return result;
}
