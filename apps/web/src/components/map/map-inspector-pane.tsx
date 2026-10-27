import { useCallback } from "react";
import {
  DESK_POLL_INTERVAL_MS,
  usePolledQuery,
} from "#/components/inbox/use-polled-query.ts";
import type {
  AnswerPayload,
  RequestView,
} from "#/components/requests/request-card-logic.ts";
import { getTrpc } from "#/integrations/trpc/client";
import type {
  AgentRecord,
  MailboxRecord,
  RouterOutputs,
} from "#/integrations/trpc/types";
import { agentIdForProfile } from "./inspector-logic.ts";
import { MapInspector } from "./map-inspector.tsx";
import type { TouchActions } from "./map-inspector-touch.tsx";

type MapGraphView = RouterOutputs["map"]["graph"];

interface EditorRecords {
  agent: AgentRecord;
  mailbox: MailboxRecord | null;
}

/** The agent and its mailbox the editor edits. Without an agent, nothing is fetched. */
const loadEditorRecords = async (
  agentId: string | null
): Promise<EditorRecords | null> => {
  if (agentId === null) {
    return null;
  }
  const trpc = getTrpc();
  const [agent, mailbox] = await Promise.all([
    trpc.agents.get.query({ id: agentId }),
    trpc.mailbox.get.query({ agentId }),
  ]);
  return { agent, mailbox };
};

/**
 * The inspector with the profile of the node's agent, fetched on selection and
 * on the same interval as the graph. Key it by node, so a new selection starts
 * from an empty profile. An agent node uses its own profile, a trigger the
 * profile of the agent it starts, and an output none. In editor mode the agent
 * and its mailbox are fetched too, for the editable rows.
 */
export function MapInspectorPane({
  editor,
  graph,
  node,
  nowMs,
  onAnswer,
  onChanged,
  onClose,
  touch,
}: {
  editor: boolean;
  graph: MapGraphView;
  node: MapGraphView["nodes"][number];
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  onChanged: () => void;
  onClose: () => void;
  touch?: TouchActions;
}) {
  const agentId = agentIdForProfile(graph, node);
  const {
    data,
    error,
    refresh: refreshProfile,
  } = usePolledQuery(
    () =>
      agentId === null
        ? Promise.resolve(null)
        : getTrpc().agentProfile.profile.query({ agentId }),
    null,
    DESK_POLL_INTERVAL_MS
  );
  const editorAgentId = editor ? agentId : null;
  const { data: editorData, refresh: refreshEditor } = usePolledQuery(
    () => loadEditorRecords(editorAgentId),
    null,
    DESK_POLL_INTERVAL_MS
  );
  const answer = useCallback(
    async (view: RequestView, payload: AnswerPayload) => {
      await onAnswer(view, payload);
      await refreshProfile();
    },
    [onAnswer, refreshProfile]
  );
  // The panels change what the rows show, so reload the profile and the agent first.
  const changed = useCallback(async () => {
    await Promise.all([refreshProfile(), refreshEditor()]);
    onChanged();
  }, [onChanged, refreshEditor, refreshProfile]);
  return (
    <MapInspector
      editor={editor}
      editorAgent={editorData?.agent ?? null}
      editorMailbox={editorData?.mailbox ?? null}
      graph={graph}
      node={node}
      nowMs={nowMs}
      onAnswer={answer}
      onChanged={changed}
      onClose={onClose}
      profile={data}
      profileAgentId={agentId}
      profileError={error}
      touch={touch}
    />
  );
}
