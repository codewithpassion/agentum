import { describe, expect, test } from "bun:test";
import type { LiveCommentThread } from "@repo/protocol/live";
import { effectiveAskKeys } from "@repo/protocol/requests";
import { ToolError } from "../result";
import { harbourmasterTools, TOOL_NAMES } from "../server";
import { textOf } from "../testing";
import { READ_ONLY, WRITE_CREATE, WRITE_UPDATE } from "./define";
import { callTool, fakePorts } from "./library-wiki.test-helpers";
import {
  documentCommentInputSchema,
  documentEditInputSchema,
  documentOperationSchema,
  type LivePort,
} from "./live";

const ID = "5b1c1a3e-0a52-4f5f-8f07-0b3d8e9a1c11";
const uncalled = (): Promise<never> =>
  Promise.reject(new Error("Port must not be called"));
const port = (overrides: Partial<LivePort> = {}): LivePort => ({
  comment: uncalled,
  comments: uncalled,
  create: uncalled,
  edit: uncalled,
  read: uncalled,
  ...overrides,
});
const call = (
  live: LivePort,
  name: string,
  args: Record<string, unknown>,
  options: Parameters<typeof callTool>[3] = {}
) => callTool(fakePorts({ live }), name, args, options);
const guarded = { blockId: "1.2", ifHash: "1234abcd", ifRev: 2 };
const edit = {
  artifactId: ID,
  ops: [
    { content: { markdown: "Risks" }, op: "replace" as const, target: guarded },
  ],
  status: "Writing risks",
  summary: "Fill risks",
};
const thread: LiveCommentThread = {
  anchor: {
    detached: true,
    end: { tname: "document" },
    kind: "document",
    start: { tname: "document" },
  },
  answeredAt: null,
  artifactId: ID,
  comments: [
    {
      authorId: "guest1",
      authorKind: "guest",
      body: "Please clarify",
      createdAt: "2026-10-27T00:00:00Z",
      deletedAt: null,
      editedAt: null,
      id: "comment1",
      runId: null,
      threadId: "thread1",
    },
  ],
  id: "thread1",
  quote: "the old words",
  resolvedAt: null,
  resolvedBy: null,
  toAgent: true,
};

describe("live document schemas", () => {
  test("block destructive edits require both guards; find needs no guard and nth is one based", () => {
    for (const op of ["replace", "delete"]) {
      const fields = op === "replace" ? { content: { text: "new" } } : {};
      for (const target of [
        { blockId: "1.2" },
        { blockId: "1.2", ifHash: "1234abcd" },
        { ...guarded, ifHash: "bad" },
        { find: "words", nth: 0 },
        { ...guarded, force: true },
      ]) {
        expect(
          documentOperationSchema.safeParse({ op, target, ...fields }).success
        ).toBe(false);
      }
      expect(
        documentOperationSchema.safeParse({ op, target: guarded, ...fields })
          .success
      ).toBe(true);
      expect(
        documentOperationSchema.safeParse({
          op,
          target: { find: "the old words", nth: 2 },
          ...fields,
        }).success
      ).toBe(true);
    }
  });
  test("pending, move, set and table ops are reusable typed inputs", () => {
    for (const op of [
      {
        content: { intent: "Risks and fallback", type: "pending" },
        op: "insert",
      },
      {
        content: { text: "Next" },
        op: "insert",
        position: "after",
        target: { blockId: "1.2" },
      },
      {
        destination: { blockId: "1.3" },
        op: "move",
        position: "before",
        target: guarded,
      },
      { attrs: { checked: true }, op: "set", target: guarded },
      { cells: ["a"], index: 0, op: "table_insert_row", target: guarded },
      { cells: ["a"], index: 0, op: "table_insert_column", target: guarded },
      { index: 0, op: "table_delete_row", target: guarded },
      { index: 0, op: "table_delete_column", target: guarded },
    ]) {
      expect(documentOperationSchema.safeParse(op).success).toBe(true);
    }
    expect(
      documentEditInputSchema.safeParse({ ...edit, ops: [] }).success
    ).toBe(false);
    expect(
      documentOperationSchema.safeParse({
        attrs: { onclick: "bad" },
        op: "set",
        target: guarded,
      }).success
    ).toBe(false);
  });
  test("comment anchors, replies and answered constraints", () => {
    for (const input of [
      {
        artifactId: ID,
        body: "Please fix",
        quote: "the old words",
        to: "agent",
      },
      { artifactId: ID, body: "Done", threadId: "t" },
      { answered: true, artifactId: ID, threadId: "t" },
      { answered: true, artifactId: ID, body: "Done", threadId: "t" },
    ]) {
      expect(documentCommentInputSchema.safeParse(input).success).toBe(true);
    }
    for (const input of [
      { body: "fix", quote: "two words" },
      { quote: "the old words" },
      { answered: true, body: "fix", quote: "the old words" },
      { threadId: "t" },
      { answered: false, threadId: "t" },
      { answered: true, quote: "the old words", threadId: "t" },
      { body: "reply", threadId: "t", to: "agent" },
      { authorId: "forged", body: "fix", quote: "the old words" },
    ]) {
      expect(
        documentCommentInputSchema.safeParse({ artifactId: ID, ...input })
          .success
      ).toBe(false);
    }
  });
});

test("registration, annotations, names and read-only filtering", () => {
  const tools = harbourmasterTools(fakePorts({ live: port() }));
  for (const [name, annotation] of [
    ["document_read", READ_ONLY],
    ["document_comments", READ_ONLY],
    ["document_edit", WRITE_UPDATE],
    ["document_comment", WRITE_CREATE],
  ] as const) {
    expect(tools.find((tool) => tool.name === name)?.annotations).toEqual(
      annotation
    );
    expect(TOOL_NAMES).toContain(name);
  }
  expect(
    harbourmasterTools(fakePorts()).some((tool) =>
      tool.name.startsWith("document_")
    )
  ).toBe(false);
  expect(
    harbourmasterTools(fakePorts({ live: port() }), { readOnly: true })
      .filter((tool) => tool.name.startsWith("document_"))
      .map((tool) => tool.name)
  ).toEqual(["document_read", "document_comments"]);
});

test("read forwards historical/delta/block queries and renders guards, pending and presence as text", async () => {
  const input = { artifactId: ID, atRev: 4, blockId: "1.2", sinceRev: 1 };
  const result = await call(
    port({
      read: (received) => {
        expect(received).toEqual(input);
        return Promise.resolve({
          artifactId: ID,
          blocks: [
            {
              hash: "1234abcd",
              id: "1.2",
              intent: "Risks and fallback",
              markdown: "# Risks",
              rev: 3,
              text: "Risks",
              type: "pending",
            },
          ],
          deletedBlockIds: ["1.1"],
          present: [
            {
              color: "#123456",
              id: "p",
              kind: "member",
              name: "Person",
              selection: ["1.2"],
            },
          ],
          revision: 4,
        });
      },
    }),
    "document_read",
    input
  );
  for (const text of [
    "revision 4",
    "1.2 1234abcd rev=3 pending",
    "Risks and fallback",
    "# Risks",
    "1.1",
    "Person",
  ]) {
    expect(textOf(result)).toContain(text);
  }
});

test("edit forwards the complete change unchanged and reports skipped outcomes", async () => {
  const result = await call(
    port({
      edit: (received) => {
        expect(received).toEqual(edit);
        return Promise.resolve({
          changeId: "change1",
          revision: 3,
          skipped: [
            { code: "guard_mismatch", index: 0, reason: "Person edited" },
          ],
        });
      },
    }),
    "document_edit",
    edit
  );
  expect(textOf(result)).toContain("Person edited");
  expect(textOf(result)).toContain("never retry");
});

test("comment and inbox port forwarding retains detached threads and answered state", async () => {
  const input = {
    answered: true as const,
    artifactId: ID,
    body: "Please clarify the removed text",
    threadId: "thread1",
  };
  const reply = await call(
    port({
      comment: (received) => {
        expect(received).toEqual(input);
        return Promise.resolve({ thread });
      },
    }),
    "document_comment",
    input
  );
  expect(reply.structuredContent).toEqual({ thread });
  const query = {
    answered: false,
    artifactId: ID,
    cursor: "next1",
    to: "agent" as const,
  };
  const inbox = await call(
    port({
      comments: (received) => {
        expect(received).toEqual(query);
        return Promise.resolve({ items: [thread], next: "next2" });
      },
    }),
    "document_comments",
    query
  );
  expect(inbox.structuredContent).toEqual({ items: [thread], next: "next2" });
  expect(textOf(inbox)).toContain("the old words");
});

test("every live mutation dry-run skips without calling a port", async () => {
  await Promise.all(
    (
      [
        ["document_edit", edit],
        [
          "document_comment",
          { artifactId: ID, body: "Fix", quote: "the old words" },
        ],
        ["document_comment", { answered: true, artifactId: ID, threadId: "t" }],
      ] as const
    ).map(async ([name, args]) => {
      const records: { summary: string; tool: string }[] = [];
      const result = await call(port(), name, args, {
        dryRun: {
          record: (skip) => {
            records.push(skip);
            return Promise.resolve();
          },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toStartWith("Skipped in dry run: would ");
      expect(records).toEqual([
        {
          summary: JSON.stringify(
            name === "document_edit"
              ? documentEditInputSchema.parse(args)
              : documentCommentInputSchema.parse(args)
          ).slice(0, 200),
          tool: name,
        },
      ]);
    })
  );
});

for (const code of [
  "guard_mismatch",
  "block_gone",
  "anchor_conflict",
  "find_not_found",
  "find_ambiguous",
  "forbidden",
] as const) {
  test(`expected ${code} failures retain code and guidance`, async () => {
    const message = "Their edit wins. Read again; never force a retry.";
    const result = await call(
      port({
        edit: () => {
          throw new ToolError(code, message);
        },
      }),
      "document_edit",
      edit
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code, message });
  });
}

test("approval keys remain exact platform keys in every runtime", () => {
  expect(
    effectiveAskKeys([
      { mode: "ask", toolKey: "harbourmaster/document_edit" },
      { mode: "ask", toolKey: "harbourmaster/document_comment" },
    ])
  ).toEqual(["harbourmaster/document_comment", "harbourmaster/document_edit"]);
});

test("schema-invalid edits never reach the live port", async () => {
  let calls = 0;
  const result = await call(
    port({
      edit: () => {
        calls += 1;
        return Promise.reject(new Error("Must not call"));
      },
    }),
    "document_edit",
    {
      artifactId: ID,
      ops: [
        {
          content: { text: "Overwrite" },
          op: "replace",
          target: { blockId: "1.2" },
        },
      ],
    }
  );
  expect(result.isError).toBe(true);
  expect(calls).toBe(0);
});

test("static doc rejection keeps the Make editable guidance from the adapter", async () => {
  const result = await call(
    port({
      edit: () =>
        Promise.reject(
          new ToolError(
            "validation",
            "This is a static doc. Choose Make editable before using document_edit."
          )
        ),
    }),
    "document_edit",
    edit
  );
  expect(result.structuredContent).toEqual({
    code: "validation",
    message:
      "This is a static doc. Choose Make editable before using document_edit.",
  });
});

test("answered updates retain a service refusal for a thread not addressed to the agent", async () => {
  const result = await call(
    port({
      comment: () =>
        Promise.reject(
          new ToolError(
            "forbidden",
            "Only threads addressed to this agent may be marked answered."
          )
        ),
    }),
    "document_comment",
    { answered: true, artifactId: ID, threadId: "thread1" }
  );
  expect(result.structuredContent).toEqual({
    code: "forbidden",
    message: "Only threads addressed to this agent may be marked answered.",
  });
});
