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
import type { RouterOutputs } from "#/integrations/trpc/types";
import { agentIdForProfile } from "./inspector-logic.ts";
import { MapInspector } from "./map-inspector.tsx";

type MapGraphView = RouterOutputs["map"]["graph"];

/**
 * The inspector with the profile of the node's agent, fetched on selection and
 * on the same interval as the graph. Key it by node, so a new selection starts
 * from an empty profile. An agent node uses its own profile, a trigger the
 * profile of the agent it starts, and an output none.
 */
export function MapInspectorPane({
  graph,
  node,
  nowMs,
  onAnswer,
  onClose,
}: {
  graph: MapGraphView;
  node: MapGraphView["nodes"][number];
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  onClose: () => void;
}) {
  const agentId = agentIdForProfile(graph, node);
  const { data, error, refresh } = usePolledQuery(
    () =>
      agentId === null
        ? Promise.resolve(null)
        : getTrpc().agentProfile.profile.query({ agentId }),
    null,
    DESK_POLL_INTERVAL_MS
  );
  const answer = useCallback(
    async (view: RequestView, payload: AnswerPayload) => {
      await onAnswer(view, payload);
      await refresh();
    },
    [onAnswer, refresh]
  );
  return (
    <MapInspector
      graph={graph}
      node={node}
      nowMs={nowMs}
      onAnswer={answer}
      onClose={onClose}
      profile={data}
      profileError={error}
    />
  );
}
