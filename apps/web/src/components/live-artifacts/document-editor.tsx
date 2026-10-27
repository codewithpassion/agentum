/** biome-ignore-all lint/performance/noJsxPropsBind: Small editor controls capture the command and its current selection. */
import { EditorContent } from "@tiptap/react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { applyBlock, blockActions } from "./editor-actions";
import { selectedContext } from "./editor-binding";
import { EditorHistory } from "./editor-history";
import { canEdit, type DocumentEditorPorts } from "./editor-ports";
import { EditorPresence } from "./editor-presence";
import { EditorToolbar, ToolButton } from "./editor-toolbar";
import { useDocumentEditor } from "./use-document-editor";
import { useSlashMenu } from "./use-slash-menu";
import "./document-editor.css";

const SLASH_QUERY = /^\/[^/]*$/;
export function DocumentEditor(ports: DocumentEditorPorts) {
  const [error, setError] = useState<string | null>(null);
  const [dismissedSlash, setDismissedSlash] = useState<number | null>(null);
  const report = useCallback(
    (value: unknown) =>
      setError(
        value instanceof Error ? value.message : "The editor action failed"
      ),
    []
  );
  const { editor, upload, revision } = useDocumentEditor(ports, report);
  const { onEditorReady } = ports;
  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);
  const participants = useSyncExternalStore(
    ports.provider.subscribe,
    ports.provider.getSnapshot,
    ports.provider.getSnapshot
  );
  const selection = editor ? selectedContext(editor) : undefined;
  const editable = canEdit(ports.role);
  const before =
    editor?.state.selection.$from.parent.textBetween(
      0,
      editor.state.selection.$from.parentOffset,
      undefined,
      "\ufffc"
    ) ?? "";
  const slash =
    editable &&
    editor?.state.selection.empty &&
    SLASH_QUERY.test(before) &&
    dismissedSlash !== editor.state.selection.from
      ? before.slice(1).toLowerCase()
      : undefined;
  const actions =
    slash === undefined
      ? []
      : blockActions.filter((action) => action.toLowerCase().includes(slash));
  const { menu, position } = useSlashMenu(
    editor,
    before,
    slash,
    actions[0],
    revision,
    setDismissedSlash
  );
  return (
    <section
      aria-label="Collaborative document editor"
      className="live-editor"
      data-revision={revision}
    >
      <EditorPresence editor={editor} port={ports.provider} />
      <div className="live-toolbar">
        {ports.history !== undefined && (
          <EditorHistory
            editable={ports.role === "owner"}
            port={ports.history}
            report={report}
          />
        )}
        {!editable && (
          <span>
            {ports.role === "commenter" ? "Comment only" : "Read only"}
          </span>
        )}
      </div>
      {Boolean(error) && (
        <div className="live-editor-error" role="alert">
          {error}
          <ToolButton onClick={() => setError(null)}>Dismiss error</ToolButton>
        </div>
      )}
      {editor !== null && (
        <EditorToolbar
          editor={editor}
          participants={participants}
          report={report}
          upload={upload}
        />
      )}
      <div className="live-editor-columns">
        <div className="live-document-main">
          {selection !== undefined && (
            <fieldset aria-label="Selection actions" className="live-toolbar">
              {ports.onAskAgent !== undefined && (
                <ToolButton onClick={() => ports.onAskAgent?.(selection)}>
                  Ask agent
                </ToolButton>
              )}
              {ports.role !== "viewer" && (
                <ToolButton onClick={() => ports.onCommentSelection(selection)}>
                  Comment on selection
                </ToolButton>
              )}
            </fieldset>
          )}
          <EditorContent editor={editor} />
          {editable && editor && slash !== undefined && (
            <fieldset
              aria-label="Insert block"
              className="live-slash-menu"
              ref={menu}
              style={position}
            >
              {actions.map((action) => (
                <ToolButton
                  key={action}
                  onClick={() => {
                    const end = editor.state.selection.from;
                    editor.commands.deleteRange({
                      from: end - before.length,
                      to: end,
                    });
                    applyBlock(editor, action);
                  }}
                >
                  {action}
                </ToolButton>
              ))}
              {!actions.length && <p>No matching blocks</p>}
              <ToolButton
                onClick={() => setDismissedSlash(editor.state.selection.from)}
              >
                Close insert menu
              </ToolButton>
            </fieldset>
          )}
        </div>
        {ports.sidebar !== null && ports.sidebar !== undefined && (
          <aside
            aria-label="Document sidebar"
            className="live-document-sidebar"
          >
            {ports.sidebar}
          </aside>
        )}
      </div>
    </section>
  );
}
