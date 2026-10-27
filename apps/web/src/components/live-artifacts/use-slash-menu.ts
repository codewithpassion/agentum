import type { Editor } from "@tiptap/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { applyBlock, type BlockAction } from "./editor-actions";

/** Keep the menu near the caret even in a long document, inside its column. */
export function useSlashMenu(
  editor: Editor | null,
  before: string,
  slash: string | undefined,
  first: BlockAction | undefined,
  revision: number,
  dismiss: (position: number) => void
) {
  const menu = useRef<HTMLFieldSetElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Transactions move the caret even when the slash query is unchanged.
  useLayoutEffect(() => {
    if (!editor || slash === undefined) {
      return;
    }
    const column = editor.view.dom.closest(".live-document-main");
    if (!column) {
      return;
    }
    const caret = editor.view.coordsAtPos(editor.state.selection.from);
    const bounds = column.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(caret.left - bounds.left, bounds.width - 320)),
      top: caret.bottom - bounds.top + 6,
    });
  }, [editor, slash, revision]);
  useEffect(() => {
    if (!editor || slash === undefined) {
      return;
    }
    const previous = editor.options.editorProps.handleKeyDown;
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        handleKeyDown: (view, event) => {
          if (event.key === "Escape") {
            dismiss(editor.state.selection.from);
            return true;
          }
          if (event.key === "ArrowDown") {
            menu.current?.querySelector("button")?.focus();
            return true;
          }
          if (event.key === "Enter" && first) {
            const to = editor.state.selection.from;
            editor.commands.deleteRange({ from: to - before.length, to });
            applyBlock(editor, first);
            return true;
          }
          return previous?.(view, event) ?? false;
        },
      },
    });
    return () => {
      if (!editor.isDestroyed) {
        editor.setOptions({
          editorProps: {
            ...editor.options.editorProps,
            handleKeyDown: previous,
          },
        });
      }
    };
  }, [editor, slash, before, first, dismiss]);
  return { menu, position };
}
