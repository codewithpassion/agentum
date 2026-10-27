import {
  deckPPTX,
  deckPrintHTML,
  documentDOCX,
  documentPrintHTML,
} from "../index";
import { assetLoader, base64 } from "../input";
import {
  assets,
  deckFixture,
  docFixture,
  malformedPNGStreams,
} from "./content";
export default {
  async fetch() {
    Object.defineProperty(globalThis, "fetch", {
      value: () => {
        throw new Error("Export attempted network access");
      },
    });
    const doc = docFixture(),
      deck = deckFixture();
    const word = await documentDOCX(doc, assets),
      ppt = await deckPPTX(deck, assets);
    const malformed = await Promise.all(
      malformedPNGStreams().map(async (bytes) => {
        try {
          await assetLoader({
            ...assets,
            read: async () => ({ bytes, mime: "image/png" }),
          })("/files/image");
          return "accepted";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })
    );
    return Response.json({
      deck: (await deckPrintHTML(deck, assets)).value,
      document: (await documentPrintHTML(doc, assets)).value,
      docx: base64(word.value),
      dom: typeof document,
      malformed,
      pptx: base64(ppt.value),
    });
  },
};
