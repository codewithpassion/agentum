import type { DeskCard } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import {
  agentInitials,
  agentTileColour,
} from "#/components/shell/agent-tile.ts";
import { cardLink, cardSubtitle } from "./desk-logic.ts";
import { StatusBandLine } from "./status-band.tsx";

const CARD_CLASS =
  "block overflow-hidden rounded-[10px] border bg-card text-card-foreground no-underline";

/** A Running or Done today card: the agent, the title, and the status band. */
export function DeskCardView({
  agentName,
  card,
  nowMs,
}: {
  agentName: string;
  card: DeskCard;
  nowMs: number;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span
          className={`grid size-[30px] shrink-0 place-items-center rounded-lg font-bold text-white text-xs ${agentTileColour(agentName)}`}
        >
          {agentInitials(agentName)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="break-words font-semibold max-md:line-clamp-2 md:truncate">
            {card.title}
          </div>
          <div className="truncate text-muted-foreground text-xs">
            {cardSubtitle(
              { agentName, at: card.at, startedBy: card.startedBy },
              nowMs
            )}
          </div>
        </div>
      </div>
      <StatusBandLine band={card.band} />
    </>
  );

  const link = cardLink(card);
  if (link?.kind === "task") {
    return (
      <Link
        className={CARD_CLASS}
        data-lane={card.lane}
        data-testid="desk-card"
        params={{ runId: link.runId }}
        to="/tasks/$runId"
      >
        {body}
      </Link>
    );
  }
  if (link?.kind === "thread") {
    return (
      <Link
        className={CARD_CLASS}
        data-lane={card.lane}
        data-testid="desk-card"
        search={{ thread: link.threadId }}
        to="/inbox"
      >
        {body}
      </Link>
    );
  }
  return (
    <div className={CARD_CLASS} data-lane={card.lane} data-testid="desk-card">
      {body}
    </div>
  );
}
