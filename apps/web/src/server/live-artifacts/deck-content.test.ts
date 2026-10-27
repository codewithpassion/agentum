import { expect, test } from "bun:test";
import { Deck, type SlideData } from "@repo/live-deck";
import { richTextCodec } from "@repo/live-deck/rich-text";
import { Doc, encodeStateAsUpdate } from "yjs";
import { deckContent } from "./deck-content";

const scope = { artifactId: crypto.randomUUID(), workspaceId: "w" };
test("deck checkpoint renders escaped validated scenes, preserves interchange and revalidates ownership", async () => {
  const owned = new Set(["/files/own"]);
  const codec = deckContent(() => Promise.resolve(owned));
  const initial = await codec.createDeck({ title: 'Title <script> & "quote"' });
  const deck = new Deck(new Doc({ gc: false }), richTextCodec, {
    ownsBlob: (path) => owned.has(path),
  });
  try {
    deck.applyUpdate(initial.state);
    const slide: SlideData = {
      background: "#fff",
      duration: "0",
      elements: [
        {
          id: "text",
          order: "a0",
          parent: "s1",
          props: { h: "50", w: "100", x: "2", y: "3" },
          style: {},
          text: [{ attrs: {}, children: ["<script>evil & text"], tag: "p" }],
          type: "text",
        },
        {
          id: "image",
          order: "a1",
          parent: "s1",
          props: {
            alt: 'Image "quoted"',
            h: "100",
            src: "/files/own",
            w: "100",
            x: "4",
            y: "5",
          },
          style: {},
          type: "image",
        },
      ],
      id: "s1",
      layout: { direction: "column", display: "flex" },
      notes: "speaker",
      order: "a0",
      transition: "none",
    };
    slide.elements.push({
      id: "link",
      order: "a2",
      parent: "s1",
      props: {
        from: "text",
        "from-anchor": "right",
        to: "image",
        "to-anchor": "left",
      },
      style: {},
      type: "connector",
    });
    deck.addSlide(slide);
    const snapshot = { revision: 2, state: encodeStateAsUpdate(deck.doc) };
    const exported = await codec.exportDeck(snapshot, scope);
    expect(exported.html).toContain("&lt;script&gt;evil &amp; text");
    expect(exported.html).not.toContain("<script>");
    expect(exported.html).toContain('src="/files/own"');
    expect(exported.html).toContain("flex-direction:column");
    expect(exported.html).toContain('x1="102" y1="28" x2="4" y2="55"');
    expect(exported.files.map((f) => f.path)).toEqual([
      "deck.json",
      "slides.html",
    ]);
    expect(new TextDecoder().decode(exported.files[1]?.bytes)).toContain(
      "<slide"
    );
    const loaded = await codec.loadDeck(snapshot.state, scope);
    expect(loaded.state).toEqual(snapshot.state);
    owned.clear();
    await expect(codec.loadDeck(snapshot.state, scope)).rejects.toThrow(
      "blob does not belong"
    );
    await expect(codec.exportDeck(snapshot, scope)).rejects.toThrow(
      "blob does not belong"
    );
  } finally {
    deck.destroy();
    deck.doc.destroy();
  }
});
test("untrusted deck checkpoints reject hidden roots without changing source", async () => {
  const codec = deckContent(() => Promise.resolve(new Set()));
  const initial = await codec.createDeck({ title: "Empty" });
  const doc = new Doc();
  try {
    const deck = new Deck(doc, richTextCodec);
    deck.applyUpdate(initial.state);
    doc.getMap("hidden").set("payload", "bad");
    await expect(
      codec.loadDeck(encodeStateAsUpdate(doc), scope)
    ).rejects.toThrow("unknown root");
    deck.destroy();
  } finally {
    doc.destroy();
  }
});
