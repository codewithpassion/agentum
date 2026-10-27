import { Deck } from "@repo/live-deck";
import { richTextCodec } from "@repo/live-deck/rich-text";
import { createDeckCheckpoint } from "@repo/mcp/tools/deck-scene";
import { parseEmbedSource } from "@repo/protocol/deck";
import type {
  LiveContentCodec,
  LiveRoomScope,
} from "@repo/services/live-artifacts/service";
import { Doc, encodeStateAsUpdate } from "yjs";
import { renderDeckCheckpoint } from "./deck-render";

export const deckContent = (
  policy: (scope: LiveRoomScope) => Promise<ReadonlySet<string>>
): Required<
  Pick<LiveContentCodec, "createDeck" | "loadDeck" | "exportDeck">
> => {
  const load = async (state: Uint8Array, scope: LiveRoomScope) => {
    const urls = await policy(scope);
    const deck = new Deck(new Doc({ gc: false }), richTextCodec, {
      // Checkpoint HTML renders only a placeholder, never the embedded source.
      // Admission remains the room's job; a later source revocation must not
      // block publishing accepted edits or loading a checkpoint for removal.
      ownsBlob: (path) => urls.has(path) || parseEmbedSource(path) !== null,
    });
    try {
      deck.applyUpdate(state);
      return deck;
    } catch (error) {
      deck.destroy();
      deck.doc.destroy();
      throw error;
    }
  };
  const close = (deck: Deck) => {
    deck.destroy();
    deck.doc.destroy();
  };
  return {
    createDeck: async (input) => ({
      revision: 0,
      state: createDeckCheckpoint(input, () => false),
    }),
    exportDeck: async (snapshot, scope) => {
      const deck = await load(snapshot.state, scope);
      try {
        const slides = deck
          .ids()
          .map((id) => ({ html: deck.readHtml(id).html, id }));
        const encoder = new TextEncoder();
        return {
          files: [
            {
              bytes: encoder.encode(
                JSON.stringify({
                  order: deck.ids(),
                  sections: deck.sections(),
                  theme: deck.theme(),
                  title: deck.doc.getMap("meta").get("title"),
                })
              ),
              path: "deck.json",
            },
            {
              bytes: encoder.encode(slides.map((s) => s.html).join("\n")),
              path: "slides.html",
            },
          ],
          html: renderDeckCheckpoint(
            deck.ids().map((id) => deck.read(id).slide),
            String(deck.doc.getMap("meta").get("title") ?? "")
          ),
          markdown: slides.map((s) => s.html).join("\n\n"),
        };
      } finally {
        close(deck);
      }
    },
    loadDeck: async (state, scope) => {
      const deck = await load(state, scope);
      try {
        return { revision: 0, state: encodeStateAsUpdate(deck.doc) };
      } finally {
        close(deck);
      }
    },
  };
};
