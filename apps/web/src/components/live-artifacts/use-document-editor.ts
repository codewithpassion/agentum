import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentDecorationsKey,
  createDocumentEditor,
  uploadEditorImage,
} from "./editor-binding";
import { EditorImagePolicy } from "./editor-image-policy";
import { canEdit, type DocumentEditorPorts } from "./editor-ports";

export function useDocumentEditor(
  ports: DocumentEditorPorts,
  report: (error: unknown) => void
) {
  const current = useRef({ ports, report });
  current.current = { ports, report };
  const { document: ydoc, provider } = ports;
  const policyState = useMemo(
    () => ({ document: ydoc, policy: new EditorImagePolicy() }),
    [ydoc]
  );
  policyState.policy.update(ports.policy.ownBlobUrls);
  const allowed = policyState.policy.uploads;
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
            policyState.policy.update(current.current.ports.policy.ownBlobUrls);
            return policyState.policy.ownBlobUrls;
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
  }, [ydoc, provider, allowed, policyState]);
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
