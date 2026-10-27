// biome-ignore-all lint/style/noNonNullAssertion: Test fixtures assert the expected blocks exist.
import { describe, expect, test } from "bun:test";
import { applyUpdate, Doc, encodeStateAsUpdate, type XmlText } from "yjs";
import { createOriginUndo, LiveDocument } from "./document";
import { fromMarkdown, toMarkdown } from "./schema";

const origin = {
  changeId: "c1",
  mode: "direct" as const,
  participantId: "agent",
  runId: "r1",
  toolCallId: "t1",
};
const create = (markdown = "Hello world.\n\nSecond paragraph.") => {
  const doc = new Doc();
  const live = new LiveDocument(doc);
  live.import({ markdown }, "init");
  return live;
};
const guard = (live: LiveDocument, id: string) => {
  const b = live.read({ blockId: id }).blocks[0]!;
  return { ifHash: b.hash, ifRev: b.revision };
};
const sync = (...docs: Doc[]) => {
  const updates = docs.map((d) => encodeStateAsUpdate(d));
  for (const doc of docs) {
    for (const u of updates) {
      applyUpdate(doc, u);
    }
  }
};
describe("shared rich document", () => {
  test("DOM-free markdown handles full basic schema and tables/checklists", () => {
    const md =
      "# Heading\n\n**Bold** *italic* ~~strike~~ `code` [link](https://example.com)\n\n- [x] done\n- [ ] todo\n\n| A | B |\n| --- | --- |\n| one | two |\n\n> quote\n\n```ts\nconst x = 1\n```\n\n---";
    const json = fromMarkdown(md);
    const out = toMarkdown(json);
    expect(JSON.stringify(json)).toContain('"table"');
    expect(JSON.stringify(json)).toContain('"taskItem"');
    expect(out).toContain("Heading");
    expect(out).toContain("one");
    expect(toMarkdown(fromMarkdown(out))).toBe(out);
  });
  test("all operations, stable IDs, guards, projections and history", () => {
    const live = create();
    const first = live.read().blocks[0]!;
    const rev = live.read().revision;
    live.apply(
      [
        {
          op: "replace",
          target: { blockId: first.id },
          ...guard(live, first.id),
          content: { text: "Changed" },
        },
      ],
      origin
    );
    expect(live.read({ sinceRev: rev }).blocks.map((b) => b.id)).toEqual([
      first.id,
    ]);
    expect(live.read({ atRev: rev }).blocks[0]!.text).toBe("Hello world.");
    live.apply(
      [
        {
          blockId: first.id,
          op: "set",
          ...guard(live, first.id),
          attrs: { level: 2 },
        },
      ],
      origin
    );
    const second = live.read().blocks[1]!;
    live.apply(
      [
        {
          blockId: second.id,
          op: "move",
          ...guard(live, second.id),
          before: first.id,
        },
      ],
      origin
    );
    expect(live.read().blocks[0]!.id).toBe(second.id);
    live.apply(
      [{ after: first.id, content: { markdown: "New block" }, op: "insert" }],
      origin
    );
    live.apply(
      [
        {
          op: "delete",
          target: { blockId: first.id },
          ...guard(live, first.id),
        },
      ],
      origin
    );
    expect(live.read({ sinceRev: rev }).deleted).toContain(first.id);
  });
  test("stale batch writes zero bytes even after a valid first operation", () => {
    const live = create();
    const first = live.read().blocks[0]!;
    const before = encodeStateAsUpdate(live.doc);
    let updates = 0;
    live.doc.on("update", () => {
      updates += 1;
    });
    expect(() =>
      live.apply(
        [
          { content: { text: "would insert" }, op: "insert" },
          {
            ifHash: "00000000",
            ifRev: first.revision,
            op: "delete",
            target: { blockId: first.id },
          },
        ],
        origin
      )
    ).toThrow("guard_mismatch");
    expect(encodeStateAsUpdate(live.doc)).toEqual(before);
    expect(updates).toBe(0);
  });
  test("find nth, ambiguous/missing targets and quoted replacement", () => {
    const live = create("hello hello");
    expect(() =>
      live.apply([{ op: "delete", target: { find: "hello" } }], origin)
    ).toThrow("ambiguous_find");
    live.apply(
      [
        {
          content: { text: "there" },
          op: "replace",
          target: { find: "hello", nth: 2 },
        },
      ],
      origin
    );
    expect(live.markdown()).toBe("hello there");
    expect(() =>
      live.apply([{ op: "delete", target: { find: "missing" } }], origin)
    ).toThrow("find_not_found");
  });
  test("pending fill preserves its id and deleted pending fails", () => {
    const live = create();
    live.apply(
      [
        {
          content: {
            json: {
              content: [{ attrs: { intent: "Write risks" }, type: "pending" }],
              type: "doc",
            },
          },
          op: "insert",
        },
      ],
      origin
    );
    const pending = live.read().blocks.find((b) => b.type === "pending")!;
    live.apply(
      [{ blockId: pending.id, content: { text: "Risks" }, op: "fill" }],
      origin
    );
    expect(live.read({ blockId: pending.id }).blocks[0]!.text).toBe("Risks");
    live.apply(
      [
        {
          op: "delete",
          target: { blockId: pending.id },
          ...guard(live, pending.id),
        },
      ],
      origin
    );
    expect(() =>
      live.apply(
        [{ blockId: pending.id, content: { text: "unwanted" }, op: "fill" }],
        origin
      )
    ).toThrow("block_gone");
  });
  test("three independent replicas type and agent inserts via relative position, converging with all edits", () => {
    const agent = create();
    const a = new Doc();
    const b = new Doc();
    sync(agent.doc, a, b);
    const humanA = new LiveDocument(a);
    const humanB = new LiveDocument(b);
    const { id } = agent.read().blocks[0]!;
    const at = agent.position(id, 6);
    const aa = humanA.resolve(humanA.position(id, 6));
    const bb = humanB.resolve(humanB.position(id, 6));
    a.transact(() => (aa.type as XmlText).insert(aa.index, "Alice "), "humanA");
    b.transact(() => (bb.type as XmlText).insert(bb.index, "Bob "), "humanB");
    agent.apply([{ at, content: { text: "Agent " }, op: "insert" }], origin);
    sync(agent.doc, a, b);
    expect(agent.json()).toEqual(humanA.json());
    expect(agent.json()).toEqual(humanB.json());
    for (const name of ["Alice", "Bob", "Agent"]) {
      expect(agent.markdown()).toContain(name);
    }
    const stale = guard(agent, id);
    const at2 = humanA.resolve(humanA.position(id, 0));
    a.transact(() => (at2.type as XmlText).insert(0, "Human wins "), "humanA");
    sync(agent.doc, a, b);
    expect(() =>
      agent.apply(
        [
          {
            op: "replace",
            target: { blockId: id },
            ...stale,
            content: { text: "lost" },
          },
        ],
        origin
      )
    ).toThrow("guard_mismatch");
  });
  test("origin undo keeps later human text and other agent changes", () => {
    const live = create();
    const { id } = live.read().blocks[0]!;
    const undo = createOriginUndo(live.doc, origin);
    live.apply(
      [{ at: live.position(id, 6), content: { text: "Agent " }, op: "insert" }],
      origin
    );
    const at = live.resolve(live.position(id, 0));
    live.doc.transact(() => (at.type as XmlText).insert(0, "Human "), "human");
    live.apply(
      [{ at: live.position(id, 0), content: { text: "Other " }, op: "insert" }],
      {}
    );
    undo.undo();
    expect(live.markdown()).toContain("Human");
    expect(live.markdown()).toContain("Other");
    expect(live.markdown()).not.toContain("Agent");
    undo.redo();
    expect(live.markdown()).toContain("Agent");
  });
  test("table row/column operations and fixed cell colors", () => {
    const live = create("| A | B |\n| --- | --- |\n| a | b |");
    const table = live.read().blocks.find((b) => b.type === "table")!;
    for (const action of [
      "insertRow",
      "insertColumn",
      "deleteRow",
      "deleteColumn",
    ] as const) {
      live.apply(
        [
          {
            action,
            blockId: table.id,
            index: 1,
            op: "table",
            ...guard(live, table.id),
          },
        ],
        origin
      );
    }
    expect(
      live.read({ blockId: table.id }).blocks[0]!.content.content
    ).toHaveLength(2);
  });
});
