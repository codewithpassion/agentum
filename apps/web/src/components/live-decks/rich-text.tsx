import { richTextCodec } from "@repo/live-deck/rich-text";
import { createExtensions } from "@repo/live-doc/schema";
import { type Editor, Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { Plugin } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { useEffect } from "react";
import { Doc, type XmlFragment } from "yjs";

/** Validate proposed ProseMirror documents with the accepted codec before ySync publishes. */
export function deckTextExtensions(fragment: XmlFragment) {
  return [
    ...createExtensions().filter((extension) => extension.name !== "uniqueID"),
    Extension.create({
      addProseMirrorPlugins: () => [
        new Plugin({
          filterTransaction: (transaction) => {
            if (!transaction.docChanged) {
              return true;
            }
            const candidate = new Doc();
            try {
              const target = candidate.getXmlFragment("text");
              prosemirrorToYXmlFragment(transaction.doc, target);
              richTextCodec.serialize(target);
              return true;
            } catch {
              return false;
            } finally {
              candidate.destroy();
            }
          },
        }),
      ],
      name: "deckSubset",
    }),
    Collaboration.configure({ fragment }),
  ];
}
export function DeckRichText({
  fragment,
  editable,
  onActive,
}: {
  fragment: XmlFragment;
  editable: boolean;
  onActive?: (editor: Editor) => void;
}) {
  const editor = useEditor(
    {
      editable,
      editorProps: { attributes: { "aria-label": "Slide rich text" } },
      extensions: deckTextExtensions(fragment),
      immediatelyRender: false,
      onFocus: ({ editor: active }) => onActive?.(active),
    },
    [fragment]
  );
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);
  return <EditorContent editor={editor} />;
}
