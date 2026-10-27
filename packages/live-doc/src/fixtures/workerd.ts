import { Doc } from "yjs";
import { createOriginUndo, LiveDocument } from "../document";
export default {
  fetch() {
    const live = new LiveDocument(new Doc());
    live.import(
      {
        markdown:
          "# Workerd\n\nHello **rich world**.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [x] Done\n\n<script>bad</script>",
      },
      "init"
    );
    const block = live.read().blocks.find((b) => b.type === "paragraph");
    if (!block) {
      throw new Error("Missing paragraph");
    }
    const origin = { changeId: "workerd" };
    const undo = createOriginUndo(live.doc, origin);
    live.apply(
      [
        {
          at: live.position(block.id, 6),
          content: { text: "agent " },
          op: "insert",
        },
      ],
      origin
    );
    const inserted = live.markdown();
    undo.undo();
    const result = {
      dom: typeof document,
      inserted,
      outline: live.read(),
      reverted: live.markdown(),
    };
    undo.destroy();
    live.destroy();
    live.doc.destroy();
    return Response.json(result);
  },
};
