import { safeLink, THEME_COLORS } from "@repo/live-doc/schema";
import type { Editor } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";

export type CaseMode = "upper" | "lower" | "title" | "sentence";
const WORD_END = /[\p{L}\p{M}]$/u;
const SENTENCE_END = /(^\s*|[.!?]\s+)$/u;
/** Replace individual text runs backwards: preserve marks, blocks and inline atoms. */
export function changeCase(editor: Editor, mode: CaseMode): boolean {
  if (!editor.isEditable || editor.state.selection.empty) {
    return false;
  }
  const { from, to } = editor.state.selection;
  const runs: {
    from: number;
    to: number;
    text: string;
    marks: typeof editor.state.storedMarks;
  }[] = [];
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) {
      return;
    }
    const start = Math.max(from, pos),
      end = Math.min(to, pos + node.nodeSize);
    runs.push({
      from: start,
      marks: [...node.marks],
      text: (node.text ?? "").slice(start - pos, end - pos),
      to: end,
    });
  });
  const combined = runs
    .map(
      (run, index) =>
        `${index > 0 && runs[index - 1]?.to !== run.from ? " " : ""}${run.text}`
    )
    .join("");
  // Track casing context across mark boundaries (including Unicode expansions).
  let offset = 0;
  const replacements = runs.map((run, index) => {
    if (index > 0 && runs[index - 1]?.to !== run.from) {
      offset += 1;
    }
    let text = "";
    for (const char of run.text) {
      const prefix = combined.slice(0, offset);
      let value = char.toLocaleLowerCase();
      if (
        mode === "upper" ||
        (mode === "title" && !WORD_END.test(prefix)) ||
        (mode === "sentence" && SENTENCE_END.test(prefix))
      ) {
        value = char.toLocaleUpperCase();
      }
      text += value;
      offset += char.length;
    }
    return { ...run, text };
  });
  const { tr } = editor.state;
  for (const run of replacements.reverse()) {
    tr.replaceWith(
      run.from,
      run.to,
      editor.schema.text(run.text, run.marks ?? undefined)
    );
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}
export const blockActions = [
  "Paragraph",
  "Heading 1",
  "Heading 2",
  "Heading 3",
  "Bullet list",
  "Numbered list",
  "Checklist",
  "Quote",
  "Code block",
  "Divider",
  "Table",
] as const;
export type BlockAction = (typeof blockActions)[number];
export function applyBlock(editor: Editor, action: BlockAction): boolean {
  if (!editor.isEditable) {
    return false;
  }
  const chain = editor.chain().focus();
  switch (action) {
    case "Paragraph":
      return chain.setParagraph().run();
    case "Heading 1":
      return chain.setHeading({ level: 1 }).run();
    case "Heading 2":
      return chain.setHeading({ level: 2 }).run();
    case "Heading 3":
      return chain.setHeading({ level: 3 }).run();
    case "Bullet list":
      return chain.toggleBulletList().run();
    case "Numbered list":
      return chain.toggleOrderedList().run();
    case "Checklist":
      return chain.toggleTaskList().run();
    case "Quote":
      return chain.toggleBlockquote().run();
    case "Code block":
      return chain.toggleCodeBlock().run();
    case "Divider":
      return chain.setHorizontalRule().run();
    case "Table":
      return chain.insertTable({ cols: 3, rows: 3, withHeaderRow: true }).run();
    default:
      return false;
  }
}
export function setEditorLink(editor: Editor, href: string): boolean {
  if (!editor.isEditable) {
    return false;
  }
  if (!href) {
    return editor.chain().focus().extendMarkRange("link").unsetLink().run();
  }
  const safe = safeLink(href);
  return safe
    ? editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: safe })
        .run()
    : false;
}
export function setThemeColor(
  editor: Editor,
  color: string,
  cell = false
): boolean {
  if (!(editor.isEditable && THEME_COLORS.includes(color))) {
    return false;
  }
  return cell
    ? editor.commands.setCellAttribute("backgroundColor", color)
    : editor.commands.setColor(color);
}
/** One transaction, not setContent: retain the rest of the collaboration document. */
export function moveBlock(
  editor: Editor,
  blockId: string,
  beforeId: string
): boolean {
  if (!editor.isEditable || blockId === beforeId) {
    return false;
  }
  const blocks: { id: string; pos: number; size: number }[] = [];
  editor.state.doc.forEach((block, pos) => {
    blocks.push({ id: block.attrs.id, pos, size: block.nodeSize });
  });
  const source = blocks.find((block) => block.id === blockId),
    target = blocks.find((block) => block.id === beforeId);
  if (!(source && target)) {
    return false;
  }
  const node = editor.state.doc.nodeAt(source.pos);
  if (!node) {
    return false;
  }
  const tr = editor.state.tr.delete(source.pos, source.pos + source.size);
  tr.insert(tr.mapping.map(target.pos), Fragment.from(node));
  editor.view.dispatch(tr);
  return true;
}
