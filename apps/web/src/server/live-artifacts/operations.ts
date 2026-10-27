import {
  type Block,
  DocumentError,
  type LiveDocument,
  type Operation,
} from "@repo/live-doc";
import { fromMarkdown } from "@repo/live-doc/schema";
import type { DocumentOperation } from "@repo/mcp/tools/live";

type Target = DocumentOperation["target"];
export const findBlock = (
  blocks: Block[],
  target: NonNullable<Target>
): Block => {
  if ("blockId" in target) {
    const block = blocks.find((b) => b.id === target.blockId);
    if (!block) {
      throw new DocumentError("block_gone");
    }
    return block;
  }
  const hits = blocks.flatMap((block) => {
    // Containers repeat descendant text; count matches only in text-bearing leaves.
    if (blocks.some((child) => child.parentId === block.id)) {
      return [];
    }
    const result: Block[] = [];
    let offset = block.text.indexOf(target.find);
    while (offset !== -1) {
      result.push(block);
      offset = block.text.indexOf(target.find, offset + target.find.length);
    }
    return result;
  });
  if (!hits.length) {
    throw new DocumentError("find_none");
  }
  if (target.nth === undefined && hits.length !== 1) {
    throw new DocumentError("ambiguous_find");
  }
  const found = hits[(target.nth ?? 1) - 1];
  if (!found) {
    throw new DocumentError("find_none");
  }
  return found;
};
const guard = (block: Block, target: NonNullable<Target>) =>
  "ifHash" in target
    ? { ifHash: target.ifHash, ifRev: target.ifRev }
    : { ifHash: block.hash, ifRev: block.revision };
const plain = (content: { text: string } | { markdown: string }) =>
  "text" in content
    ? content
    : {
        text:
          fromMarkdown(content.markdown)
            .content?.map(
              (n) =>
                n.text ?? n.content?.map((c) => c.text ?? "").join("") ?? ""
            )
            .join("\n") ?? "",
      };
export const translateOperation = (
  live: LiveDocument,
  op: DocumentOperation
): Operation => {
  const { blocks } = live.read();
  if (op.op === "insert") {
    const target = op.target ? findBlock(blocks, op.target) : null;
    const content =
      "type" in op.content
        ? {
            json: {
              content: [
                { attrs: { intent: op.content.intent }, type: "pending" },
              ],
              type: "doc",
            },
          }
        : op.content;
    return {
      content,
      op: "insert",
      ...(target
        ? { [op.position === "before" ? "before" : "after"]: target.id }
        : {}),
    };
  }
  const block = findBlock(blocks, op.target);
  const guarded = guard(block, op.target);
  switch (op.op) {
    case "replace":
      return {
        op: "replace",
        target: op.target,
        ...guarded,
        content: "find" in op.target ? plain(op.content) : op.content,
      };
    case "delete":
      return { op: "delete", target: op.target, ...guarded };
    case "move":
      return {
        blockId: block.id,
        op: "move",
        ...guarded,
        [op.position]: findBlock(blocks, op.destination).id,
      };
    case "set": {
      const { type, ...attrs } = op.attrs;
      if (
        (attrs.level ?? 1) > 3 ||
        type === "blockquote" ||
        type === "codeBlock"
      ) {
        throw new DocumentError("invalid_content");
      }
      return { attrs, blockId: block.id, op: "set", type, ...guarded };
    }
    default: {
      return tableOperation(block, op, guarded);
    }
  }
};

const tableOperation = (
  block: Block,
  op: Extract<
    DocumentOperation,
    {
      op:
        | "table_insert_row"
        | "table_delete_row"
        | "table_insert_column"
        | "table_delete_column";
    }
  >,
  guarded: { ifRev: number; ifHash: string }
): Operation => {
  const actions = {
    table_delete_column: "deleteColumn",
    table_delete_row: "deleteRow",
    table_insert_column: "insertColumn",
    table_insert_row: "insertRow",
  } as const;
  if (!("cells" in op)) {
    return {
      action: actions[op.op],
      blockId: block.id,
      index: op.index,
      op: "table",
      ...guarded,
    };
  }
  // Replace the guarded table JSON once, preserving supplied plain-text cells
  // as part of the same all-or-nothing room change.
  const table = structuredClone(block.content);
  const rows = table.content ?? [];
  const cell = (text: string) => ({
    content: [
      { content: text ? [{ text, type: "text" }] : [], type: "paragraph" },
    ],
    type: "tableCell",
  });
  if (op.op === "table_insert_row") {
    if (
      !rows[0] ||
      op.cells.length !== rows[0].content?.length ||
      op.index > rows.length
    ) {
      throw new DocumentError("invalid_position");
    }
    rows.splice(op.index, 0, {
      content: op.cells.map(cell),
      type: "tableRow",
    });
  } else {
    if (
      op.cells.length !== rows.length ||
      rows.some((r) => op.index > (r.content?.length ?? 0))
    ) {
      throw new DocumentError("invalid_position");
    }
    rows.forEach((row, i) => {
      row.content?.splice(op.index, 0, cell(op.cells[i] ?? ""));
    });
  }
  if (
    rows.some((row) =>
      row.content?.some(
        (c) => (c.attrs?.colspan ?? 1) > 1 || (c.attrs?.rowspan ?? 1) > 1
      )
    )
  ) {
    throw new DocumentError("invalid_content");
  }
  table.content = rows;
  return {
    op: "replace",
    target: { blockId: block.id },
    ...guarded,
    content: { json: { content: [table], type: "doc" } },
  };
};
