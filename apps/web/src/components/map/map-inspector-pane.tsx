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
import type { AgentRecord, RouterOutputs } from "#/integrations/trpc/types";
import { agentIdForProfile } from "./inspector-logic.ts";
import { MapInspector } from "./map-inspector.tsx";
import type { TouchActions } from "./map-inspector-touch.tsx";

type MapGraphView = RouterOutputs["map"]["graph"];

/** The agent the editor links from. Without an agent, nothing is fetched. */
const loadEditorAgent = (
  agentId: string | null
): Promise<AgentRecord | null> =>
  agentId === null
    ? Promise.resolve(null)
    : getTrpc().agents.get.query({ id: agentId });

/**
 * The inspector with the profile of the node's agent, fetched on selection and
 * on the same interval as the graph. Key it by node, so a new selection starts
 * from an empty profile. An agent node uses its own profile, a trigger the
 * profile of the agent it starts, and an output none. In editor mode the agent
 * is fetched too, for the links into its room.
 */
export function MapInspectorPane({
  editor,
  graph,
  node,
  nowMs,
  onAnswer,
  onClose,
  touch,
}: {
  editor: boolean;
  graph: MapGraphView;
  node: MapGraphView["nodes"][number];
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
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
  const { data: editorAgent } = usePolledQuery(
    () => loadEditorAgent(editorAgentId),
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
  return (
    <MapInspector
      editor={editor}
      editorAgent={editorAgent}
      graph={graph}
      node={node}
      nowMs={nowMs}
      onAnswer={answer}
      onClose={onClose}
      profile={data}
      profileAgentId={agentId}
      profileError={error}
      touch={touch}
    />
  );
}
