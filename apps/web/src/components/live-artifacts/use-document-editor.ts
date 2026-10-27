import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentDecorationsKey,
  createDocumentEditor,
  uploadEditorImage,
} from "./editor-binding";
import { canEdit, type DocumentEditorPorts } from "./editor-ports";

export function useDocumentEditor(
  ports: DocumentEditorPorts,
  report: (error: unknown) => void
) {
  const current = useRef({ ports, report });
  current.current = { ports, report };
  const { document: ydoc, provider } = ports;
  const policyState = useMemo(
    () => ({ document: ydoc, urls: new Set<string>() }),
    [ydoc]
  );
  const allowed = policyState.urls;
  for (const url of ports.policy.ownBlobUrls ?? []) {
    allowed.add(url);
  }
  const [editor, setEditor] = useState<Editor | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let instance: Editor;
    try {
      instance = createDocumentEditor({
        ...current.current.ports,
        document: ydoc,
        policy: {
          get ownBlobUrls() {
            return new Set([
              ...(current.current.ports.policy.ownBlobUrls ?? []),
              ...allowed,
            ]);
          },
        },
        provider,
      });
    } catch (error) {
      current.current.report(error);
      setEditor(null);
      return;
    }
    instance.setOptions({
      editorProps: {
        ...instance.options.editorProps,
        handlePaste: (_view, event) => {
          const images = [...(event.clipboardData?.files ?? [])].filter(
            (file) => file.type.startsWith("image/")
          );
          if (!images.length) {
            return false;
          }
          event.preventDefault();
          if (instance.isEditable) {
            for (const image of images) {
              uploadEditorImage(
                instance,
                image,
                current.current.ports,
                allowed
              ).catch(current.current.report);
            }
          }
          return true;
        },
      },
    });
    const update = () => setRevision((value) => value + 1);
    instance.on("transaction", update);
    setEditor(instance);
    return () => {
      instance.off("transaction", update);
      instance.destroy();
    };
  }, [ydoc, provider, allowed]);
  useEffect(() => {
    editor?.setEditable(canEdit(ports.role));
  }, [editor, ports.role]);
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.view.dispatch(
        editor.state.tr.setMeta(agentDecorationsKey, ports.agentChanges ?? [])
      );
    }
  }, [editor, ports.agentChanges]);
  return {
    editor,
    revision,
    upload: async (file: File) => {
      if (editor) {
        await uploadEditorImage(editor, file, current.current.ports, allowed);
      }
    },
  };
}
