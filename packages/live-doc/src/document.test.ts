// biome-ignore-all lint/style/noNonNullAssertion: Test fixtures assert the expected blocks exist.
import { describe, expect, test } from "bun:test";
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  type XmlElement,
  type XmlText,
} from "yjs";
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

test("replayable selective revert survives room restart and preserves later replica typing", () => {
  const live = create();
  const first = live.read().blocks[0]!;
  const { change } = live.capture(
    [
      {
        op: "replace",
        target: { blockId: first.id },
        ...guard(live, first.id),
        content: { text: "Hello agent world." },
      },
    ],
    origin
  );
  const human = new Doc();
  sync(live.doc, human);
  const editor = new LiveDocument(human);
  const at = editor.resolve(editor.position(first.id, 0));
  human.transact(() => (at.type as XmlText).insert(0, "Human "), "human");
  sync(live.doc, human);
  const restored = new Doc();
  applyUpdate(restored, encodeStateAsUpdate(live.doc));
  const room = new LiveDocument(restored, { revision: live.read().revision });
  live.destroy();
  live.doc.destroy();
  room.revert(change, { participantId: "person" });
  expect(room.markdown()).toContain("Human");
  expect(room.markdown()).not.toContain("agent");
  expect(room.markdown()).toContain("Hello world.");
});
test("comment relative ranges track typing, block destructive agent ops, and detach after human deletion", () => {
  const doc = new Doc();
  let ranges: Array<{
    start: import("@repo/protocol/live").RelativePositionJSON;
    end: import("@repo/protocol/live").RelativePositionJSON;
  }> = [];
  const live = new LiveDocument(doc, { protectedRanges: () => ranges });
  live.import({ text: "Hello world." }, "init");
  const first = live.read().blocks[0]!;
  const anchor = live.anchor(first.id, 6, 11);
  if (anchor.kind !== "document") {
    throw new Error("wrong anchor");
  }
  ranges = [anchor];
  const at = live.resolve(live.position(first.id, 0));
  doc.transact(() => (at.type as XmlText).insert(0, "Human "), "human");
  const resolved = live.resolveAnchor(anchor);
  expect(resolved.detached).toBe(false);
  expect(resolved.start?.index).toBe(12);
  const before = encodeStateAsUpdate(doc);
  expect(() =>
    live.apply(
      [
        {
          op: "delete",
          target: { blockId: first.id },
          ...guard(live, first.id),
        },
      ],
      origin
    )
  ).toThrow("comment_anchor");
  expect(encodeStateAsUpdate(doc)).toEqual(before);
  expect(() =>
    live.apply(
      [{ content: { text: "new" }, op: "replace", target: { find: "world" } }],
      origin
    )
  ).toThrow("comment_anchor");
  doc.transact(
    () => (resolved.start!.type as XmlText).delete(resolved.start!.index, 5),
    "human"
  );
  expect(live.resolveAnchor(anchor).detached).toBe(true);
});
test("empty paragraph relative insertion, hard breaks, chips, rich marks and stable import IDs", () => {
  const live = create("");
  const first = live.read().blocks[0]!;
  expect(first.content.attrs?.id).toBe(first.id);
  live.apply(
    [
      {
        at: live.position(first.id, 0),
        content: { text: "text" },
        op: "insert",
      },
    ],
    origin
  );
  expect(live.markdown()).toBe("text");
  live.import(
    {
      json: {
        content: [
          {
            content: [
              { attrs: { label: "Alice", value: "member" }, type: "mention" },
              {
                marks: [
                  { type: "underline" },
                  { attrs: { color: "#3b82f6" }, type: "textStyle" },
                ],
                text: " hello",
                type: "text",
              },
              { type: "hardBreak" },
              { attrs: { label: "Today", value: "2026-10-27" }, type: "date" },
            ],
            type: "paragraph",
          },
        ],
        type: "doc",
      },
    },
    "human"
  );
  const block = live.read().blocks[0]!;
  live.apply(
    [
      {
        content: { text: "hi" },
        op: "replace",
        target: { blockId: block.id, find: "hello" },
      },
    ],
    origin
  );
  expect(live.read().blocks[0]!.text).toBe("Alice hi\nToday");
  expect(JSON.stringify(live.json())).toContain("underline");
  expect(JSON.stringify(live.json())).toContain("#3b82f6");
});
test("deleted pending and positions from disconnected replica cannot resurrect the block", () => {
  const live = create();
  live.apply(
    [
      {
        content: {
          json: {
            content: [{ attrs: { intent: "Plan" }, type: "pending" }],
            type: "doc",
          },
        },
        op: "insert",
      },
    ],
    origin
  );
  const human = new Doc();
  sync(live.doc, human);
  const editor = new LiveDocument(human);
  const pending = editor.read().blocks.find((b) => b.type === "pending")!;
  editor.apply(
    [
      {
        op: "delete",
        target: { blockId: pending.id },
        ...guard(editor, pending.id),
      },
    ],
    {}
  );
  sync(live.doc, human);
  const before = encodeStateAsUpdate(live.doc);
  expect(() =>
    live.apply(
      [{ blockId: pending.id, content: { text: "unwanted" }, op: "fill" }],
      origin
    )
  ).toThrow("block_gone");
  expect(encodeStateAsUpdate(live.doc)).toEqual(before);
  const first = live.read().blocks[0]!;
  const at = live.position(first.id, 2);
  live.apply(
    [{ op: "delete", target: { blockId: first.id }, ...guard(live, first.id) }],
    origin
  );
  expect(() =>
    live.apply([{ at, content: { text: "ghost" }, op: "insert" }], origin)
  ).toThrow("invalid_position");
});

test("block reconciliation preserves unchanged Yjs text under disconnected human typing", () => {
  const agent = create("Alpha keep Omega");
  const human = new Doc();
  sync(agent.doc, human);
  const editor = new LiveDocument(human);
  const first = agent.read().blocks[0]!;
  const anchor = editor.anchor(first.id, 6, 10);
  if (anchor.kind !== "document") {
    throw new Error("wrong anchor");
  }
  const at = editor.resolve(editor.position(first.id, 6));
  human.transact(
    () => (at.type as XmlText).insert(at.index, "HUMAN "),
    "human"
  );
  agent.apply(
    [
      {
        op: "replace",
        target: { blockId: first.id },
        ...guard(agent, first.id),
        content: { text: "Alpha keep Beta" },
      },
    ],
    origin
  );
  sync(agent.doc, human);
  expect(agent.markdown()).toContain("HUMAN");
  expect(agent.markdown()).toContain("Beta");
  expect(agent.json()).toEqual(editor.json());
  expect(editor.resolveAnchor(anchor).detached).toBe(false);
});
test("concurrent table cell typing and row insertion preserves all cells on replicas", () => {
  const agent = create("| A | B |\n| --- | --- |\n| one | two |");
  const human = new Doc();
  sync(agent.doc, human);
  const editor = new LiveDocument(human);
  const table = agent.read().blocks.find((b) => b.type === "table")!;
  const paragraph = editor
    .read()
    .blocks.find((b) => b.text === "one" && b.type === "paragraph")!;
  const at = editor.resolve(editor.position(paragraph.id, 0));
  human.transact(() => (at.type as XmlText).insert(0, "Human "), "human");
  agent.apply(
    [
      {
        blockId: table.id,
        op: "table",
        ...guard(agent, table.id),
        action: "insertRow",
        index: 1,
      },
    ],
    origin
  );
  sync(agent.doc, human);
  expect(agent.json()).toEqual(editor.json());
  expect(agent.markdown()).toContain("Human one");
  expect(
    agent.read({ blockId: table.id }).blocks[0]!.content.content
  ).toHaveLength(3);
});
test("many delayed three-replica updates converge with each insert retained", () => {
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const agent = create("Base text.");
    const a = new Doc();
    const b = new Doc();
    sync(agent.doc, a, b);
    const aa = new LiveDocument(a);
    const bb = new LiveDocument(b);
    const first = agent.read().blocks[0]!;
    const position = agent.position(first.id, 5);
    for (let round = 0; round < 4; round += 1) {
      for (const [editor, label] of [
        [aa, "A"],
        [bb, "B"],
      ] as const) {
        const at = editor.resolve(editor.position(first.id, 5));
        editor.doc.transact(
          () => (at.type as XmlText).insert(at.index, `${label}${round} `),
          label
        );
      }
      agent.apply(
        [{ at: position, content: { text: `C${round} ` }, op: "insert" }],
        origin
      );
    }
    if (iteration % 2) {
      sync(b, agent.doc, a);
    } else {
      sync(a, b, agent.doc);
    }
    expect(agent.json()).toEqual(aa.json());
    expect(agent.json()).toEqual(bb.json());
    for (const name of ["A", "B", "C"]) {
      for (let n = 0; n < 4; n += 1) {
        expect(agent.markdown()).toContain(`${name}${n}`);
      }
    }
  }
});

test("set changes list kind and check state without replacing list text", () => {
  const live = create("- one\n- two");
  const list = live.read().blocks.find((b) => b.type === "bulletList")!;
  live.apply(
    [
      {
        blockId: list.id,
        op: "set",
        ...guard(live, list.id),
        attrs: {},
        type: "taskList",
      },
    ],
    origin
  );
  const item = live.read().blocks.find((b) => b.type === "taskItem")!;
  live.apply(
    [
      {
        blockId: item.id,
        op: "set",
        ...guard(live, item.id),
        attrs: { checked: true },
      },
    ],
    origin
  );
  expect(live.markdown()).toContain("[x] one");
  live.apply(
    [
      {
        blockId: list.id,
        op: "set",
        ...guard(live, list.id),
        attrs: { start: 3 },
        type: "orderedList",
      },
    ],
    origin
  );
  expect(live.markdown()).toContain("3. one");
});
test("restore checkpoint is a single fresh origin change and rejects unsafe snapshots", () => {
  const live = create("old");
  const snapshot = encodeStateAsUpdate(live.doc);
  live.import({ text: "current" }, "human");
  const before = live.read().revision;
  live.restoreSnapshot(snapshot, { participantId: "person" });
  expect(live.markdown()).toBe("old");
  expect(live.read().revision).toBe(before + 1);
  const bad = new Doc();
  applyUpdate(bad, snapshot);
  const el = bad.getXmlFragment("content").get(0) as XmlElement;
  el.setAttribute("onerror", "bad");
  const state = encodeStateAsUpdate(live.doc);
  expect(() => live.restoreSnapshot(encodeStateAsUpdate(bad), {})).toThrow(
    "invalid_content"
  );
  expect(encodeStateAsUpdate(live.doc)).toEqual(state);
});

test("every destructive guard requires both current hash and block revision", () => {
  const live = create();
  const block = live.read().blocks[0]!;
  for (const bad of [
    { ifHash: block.hash },
    { ifRev: block.revision },
    { ifHash: "00000000", ifRev: block.revision },
    { ifHash: block.hash, ifRev: block.revision + 1 },
  ]) {
    for (const op of ["delete", "replace"] as const) {
      const before = encodeStateAsUpdate(live.doc);
      expect(() =>
        live.apply(
          [
            {
              op,
              target: { blockId: block.id },
              ...bad,
              content: { text: "overwrite" },
            },
          ],
          origin
        )
      ).toThrow("guard_mismatch");
      expect(encodeStateAsUpdate(live.doc)).toEqual(before);
    }
  }
});
test("resurrected block is returned as changed without a current tombstone; history keeps its old deletion", () => {
  const live = create();
  const block = live.read().blocks[0]!;
  const before = live.read().revision;
  const manager = createOriginUndo(live.doc, origin);
  live.apply(
    [{ op: "delete", target: { blockId: block.id }, ...guard(live, block.id) }],
    origin
  );
  const deleted = live.read().revision;
  manager.undo();
  expect(live.read({ sinceRev: before }).deleted).not.toContain(block.id);
  expect(
    live.read({ sinceRev: before }).blocks.some((b) => b.id === block.id)
  ).toBe(true);
  expect(live.read({ atRev: deleted, sinceRev: before }).deleted).toContain(
    block.id
  );
});
