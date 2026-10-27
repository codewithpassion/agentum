import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  type XmlElement,
  type XmlText,
} from "yjs";
import { Deck, parseSlide } from "../index";
import { richTextCodec as codec } from "../rich-text";
import { slide } from "./rich-text";
import migrationCapture from "./structural-migration.json";
import splitCapture from "./structural-split.json";

export default {
  fetch() {
    const migrated = new Deck(new Doc(), codec);
    migrated.applyUpdate(new Uint8Array(migrationCapture.state));
    migrated.restore(encodeStateAsUpdate(migrated.doc));
    migrated.validate();
    const split = new Deck(new Doc(), codec);
    split.applyUpdate(new Uint8Array(splitCapture.state));
    split.validate();
    const deck = new Deck(new Doc(), codec);
    deck.addSlide(slide());
    const observed = deck.readHtml("s");
    const parsed = parseSlide(observed.html, codec);
    const replica = new Doc();
    applyUpdate(replica, encodeStateAsUpdate(deck.doc));
    const shadow = new Deck(replica, codec);
    const paragraph = shadow.textFragment("s", "text").get(0) as XmlElement;
    const text = paragraph.get(0) as XmlText;
    text.insert(0, "worker ", { bold: {} });
    deck.applyUpdate(encodeStateAsUpdate(replica, encodeStateVector(deck.doc)));
    const accepted = deck.readHtml("s").html;
    const before = encodeStateVector(deck.doc);
    text.format(0, 1, {
      link: {
        evil: "hidden",
        href: "https://example.com",
        rel: "noopener noreferrer",
        target: "_blank",
      },
    });
    let refused = false;
    try {
      deck.applyUpdate(encodeStateAsUpdate(replica, before));
    } catch {
      refused = true;
    }
    const after = encodeStateVector(deck.doc);
    return Response.json({
      accepted,
      cells: parsed.elements.find((element) => element.type === "table")?.cells,
      dom: typeof (globalThis as { document?: unknown }).document,
      migrations: migrated.ids().length === 2 && split.ids().length === 1,
      refused,
      unchanged: before.toString() === after.toString(),
    });
  },
};
