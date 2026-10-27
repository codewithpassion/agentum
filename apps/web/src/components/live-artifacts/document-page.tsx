/** biome-ignore-all lint/performance/noJsxPropsBind: Selection handlers capture their panel intent. */
import type { Editor } from "@tiptap/core";
import {
  Component,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ExportControls } from "../live-exports/export-controls";
import { CollaborationPanel, type PanelIntent } from "./collaboration-panel";
import { DocumentEditor } from "./document-editor";
import { documentServices } from "./document-services";
import type {
  AgentDecoration,
  EditorRole,
  EditorSelection,
} from "./editor-ports";
import { ToolButton } from "./editor-toolbar";
import { liveApi } from "./live-api";
import { TicketedRoom } from "./room-provider";
import "./document-page.css";

// biome-ignore lint/style/useReactFunctionComponents: React error boundaries require a class.
class EditorBoundary extends Component<
  { children: ReactNode },
  { error?: string }
> {
  override state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    return {
      error:
        error instanceof Error ? error.message : "Document could not be opened",
    };
  }
  override render() {
    return this.state.error ? (
      <p role="alert">{this.state.error}</p>
    ) : (
      this.props.children
    );
  }
}
const RETRYABLE_CONNECTION =
  /^(Room disconnected|Could not connect|Room synchronization|Room renewal)/;
const EMPTY_CHANGES: readonly AgentDecoration[] = [];
const noPolicySubscription = () => () => undefined;
const emptyChanges = () => EMPTY_CHANGES;
export function LiveDocumentPage({
  artifactId,
  title,
}: {
  artifactId: string;
  title: string;
}) {
  const retries = useRef(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState<TicketedRoom>();
  const [error, setError] = useState<string>();
  const [role, setRole] = useState<EditorRole>("viewer");
  const [intent, setIntent] = useState<PanelIntent>();
  const services = useMemo(() => documentServices(artifactId), [artifactId]);
  const agentChanges = useSyncExternalStore(
    ready?.subscribePolicy ?? noPolicySubscription,
    ready?.getAgentChanges ?? emptyChanges,
    emptyChanges
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt intentionally recreates a rejected connection.
  useEffect(() => {
    setReady(undefined);
    setError(undefined);
    setIntent(undefined);
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const room = new TicketedRoom({
      failed: (message) => {
        setReady(undefined);
        setError(message);
        if (RETRYABLE_CONNECTION.test(message) && retries.current < 5) {
          const delay = Math.min(30_000, 1000 * 2 ** retries.current);
          retries.current += 1;
          retryTimer = setTimeout(() => setAttempt((old) => old + 1), delay);
        }
      },
      join: () => liveApi.join.mutate({ artifactId }),
      policy: services.policy,
      ready: (connected) => {
        retries.current = 0;
        setReady(connected);
      },
      roleChanged: setRole,
    });
    room.connect();
    return () => {
      clearTimeout(retryTimer);
      room.dispose();
      setTimeout(() => room.document.destroy(), 0);
    };
  }, [artifactId, attempt, services]);
  const select = (kind: "ask" | "comment", selection: EditorSelection) => {
    ready?.select(selection.start, selection.end);
    setIntent({ kind, nonce: crypto.randomUUID(), selection });
  };
  return (
    <main className="live-document-page">
      <header>
        <a href="/artifacts">Artifacts</a>
        <h1>{title}</h1>
        <span>{ready ? `Connected · ${role}` : "Disconnected"}</span>
      </header>
      <ExportControls
        artifactId={artifactId}
        connected={ready !== undefined}
        key={artifactId}
        kind="document"
      />
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <p>
            Reconnecting reloads the accepted room state. Unaccepted local
            changes are discarded.
          </p>
          <ToolButton onClick={() => setAttempt((old) => old + 1)}>
            Reconnect
          </ToolButton>
        </div>
      ) : (
        !ready && (
          <p role="status">Connecting and verifying document content…</p>
        )
      )}
      {ready !== undefined && (
        <EditorBoundary key={attempt}>
          <DocumentEditor
            agentChanges={agentChanges}
            document={ready.document}
            history={services.history}
            importImage={services.importImage}
            onAskAgent={(selection) => select("ask", selection)}
            onCommentSelection={(selection) => select("comment", selection)}
            onEditorReady={setEditor}
            policy={ready.policy}
            provider={ready.presence}
            role={role}
            sidebar={
              <CollaborationPanel
                artifactId={artifactId}
                editor={editor}
                intent={intent}
                room={ready}
              />
            }
            uploadImage={services.uploadImage}
          />
        </EditorBoundary>
      )}
    </main>
  );
}
