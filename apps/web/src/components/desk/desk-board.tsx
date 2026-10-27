import type { DeskCard } from "@repo/db/shared";
import { useCallback, useState } from "react";
import type {
  AnswerPayload,
  RequestView,
} from "#/components/requests/request-card-logic.ts";
import { Button } from "#/components/ui/button.tsx";
import type { DeskView } from "#/integrations/trpc/types.ts";
import { DeskCardView } from "./desk-card.tsx";
import { DeskLaneColumn } from "./desk-lane.tsx";
import { NeedsYouCard } from "./needs-you-card.tsx";

/** The skill version a proposal card stands for. */
export interface ProposedVersion {
  number: number;
  skillId: string;
}

/** How many Done cards a phone shows before "Show more". */
const DONE_PREVIEW = 5;

/** The Done cards. From md up all show. On a phone the latest few show, then "Show more". */
function DoneCards({
  cards,
  nameOf,
  nowMs,
}: {
  cards: readonly DeskCard[];
  nameOf: (card: DeskCard) => string;
  nowMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const showMore = useCallback(() => setExpanded(true), []);
  const hidden = expanded ? 0 : Math.max(cards.length - DONE_PREVIEW, 0);
  return (
    <>
      {cards.map((card, index) => (
        <div
          className={
            index >= DONE_PREVIEW && !expanded ? "max-md:hidden" : undefined
          }
          key={card.id}
        >
          <DeskCardView agentName={nameOf(card)} card={card} nowMs={nowMs} />
        </div>
      ))}
      {hidden > 0 ? (
        <Button
          className="md:hidden"
          onClick={showMore}
          type="button"
          variant="outline"
        >
          Show {hidden} more
        </Button>
      ) : null}
    </>
  );
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
  const nameOf = useCallback(
    (card: DeskCard): string =>
      card.actorKind === "user"
        ? card.startedBy
        : (agentNames.get(card.agentId) ?? "An agent"),
    [agentNames]
  );

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
        <DoneCards cards={desk.done} nameOf={nameOf} nowMs={nowMs} />
      </DeskLaneColumn>
    </div>
  );
}
