import {
  deckPPTX,
  deckPrintHTML,
  documentDOCX,
  documentPrintHTML,
} from "../index";
import { base64 } from "../input";
import { assets, deckFixture, docFixture } from "./content";
export default {
  async fetch() {
    const doc = docFixture(),
      deck = deckFixture();
    const word = await documentDOCX(doc, assets),
      ppt = await deckPPTX(deck, assets);
    return Response.json({
      deck: (await deckPrintHTML(deck, assets)).value,
      document: (await documentPrintHTML(doc, assets)).value,
      docx: base64(word.value),
      dom: typeof document,
      pptx: base64(ppt.value),
    });
  },
};
