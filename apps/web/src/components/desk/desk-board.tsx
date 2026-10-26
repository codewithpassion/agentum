import type { DeskCard } from "@repo/db/shared";
import type {
  AnswerPayload,
  RequestView,
} from "#/components/requests/request-card-logic.ts";
import type { DeskView } from "#/integrations/trpc/types.ts";
import { DeskCardView } from "./desk-card.tsx";
import { DeskLaneColumn } from "./desk-lane.tsx";
import { NeedsYouCard } from "./needs-you-card.tsx";

/** The skill version a proposal card stands for. */
export interface ProposedVersion {
  number: number;
  skillId: string;
}

/** The three lanes of the desk. */
export function DeskBoard({
  agentNames,
  desk,
  nowMs,
  onAnswer,
  onChanged,
  requests,
  versions,
}: {
  agentNames: ReadonlyMap<string, string>;
  desk: DeskView;
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  onChanged: () => void;
  requests: ReadonlyMap<string, RequestView>;
  versions: ReadonlyMap<string, ProposedVersion>;
}) {
  const nameOf = (card: DeskCard): string =>
    card.actorKind === "user"
      ? card.startedBy
      : (agentNames.get(card.agentId) ?? "An agent");

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] items-start gap-4">
      <DeskLaneColumn count={desk.needsYou.length} lane="needs_you">
        {desk.needsYou.map((card) => (
          <NeedsYouCard
            agentName={nameOf(card)}
            card={card}
            key={`${card.kind}-${card.id}`}
            nowMs={nowMs}
            onAnswer={onAnswer}
            onChanged={onChanged}
            request={requests.get(card.id) ?? null}
            version={versions.get(card.id) ?? null}
          />
        ))}
      </DeskLaneColumn>
      <DeskLaneColumn count={desk.running.length} lane="running">
        {desk.running.map((card) => (
          <DeskCardView
            agentName={nameOf(card)}
            card={card}
            key={card.id}
            nowMs={nowMs}
          />
        ))}
      </DeskLaneColumn>
      <DeskLaneColumn
        count={desk.done.length + desk.doneMore}
        lane="done"
        more={desk.doneMore}
      >
        {desk.done.map((card) => (
          <DeskCardView
            agentName={nameOf(card)}
            card={card}
            key={card.id}
            nowMs={nowMs}
          />
        ))}
      </DeskLaneColumn>
    </div>
  );
}
