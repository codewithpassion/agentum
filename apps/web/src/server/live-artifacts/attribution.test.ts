import { expect, test } from "bun:test";
import { LiveDocument } from "@repo/live-doc";
import { Doc, encodeStateAsUpdate } from "yjs";
import { insertedRanges } from "./attribution";

test("attribution follows inserted CRDT characters, excluding later human inserts and replacements", () => {
  const live = new LiveDocument(new Doc({ gc: false }));
  live.import({ markdown: "Original words." }, {});
  const change = live.capture(
    [
      {
        content: { text: "Agent" },
        op: "replace",
        target: { find: "Original" },
      },
    ],
    {
      changeId: "c",
      mode: "direct",
      participantId: "a:a:r",
      runId: "r",
      toolCallId: "tool",
    }
  );
  const actor = { id: "c", name: "Trusted Agent" };
  expect(
    insertedRanges(live, change.change.update, actor)
      .map((r) => r.text)
      .join("")
  ).toBe("Agent");
  live.apply(
    [{ content: { text: "Agent" }, op: "replace", target: { find: "Agent" } }],
    {}
  );
  expect(insertedRanges(live, change.change.update, actor)).toHaveLength(0);
  expect(encodeStateAsUpdate(live.doc).length).toBeGreaterThan(0);
  live.destroy();
  live.doc.destroy();
});
