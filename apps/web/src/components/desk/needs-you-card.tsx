import type { DeskCard, NeedsYouKind } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { RequestCard } from "#/components/requests/request-card.tsx";
import type {
  AnswerPayload,
  RequestView,
} from "#/components/requests/request-card-logic.ts";
import {
  agentInitials,
  agentTileColour,
} from "#/components/shell/agent-tile.ts";
import { buttonVariants } from "#/components/ui/button.tsx";
import { SuggestionReview } from "#/components/wiki-suggestions/suggestion-review.tsx";
import { ConflictResolver } from "./conflict-resolver.tsx";
import { ProposalActions } from "./proposal-actions.tsx";

const BOX_CLASS =
  "flex flex-col gap-3 rounded-[10px] border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40";

const HEADINGS: Record<NeedsYouKind, (agentName: string) => string> = {
  approval: (name) => `${name} asks for approval`,
  inbox_reply: (name) => `${name} replied`,
  library_conflict: (name) => `${name} left a library conflict`,
  question: (name) => `${name} asks`,
  routine_proposal: (name) => `${name} proposed a routine`,
  skill_proposal: (name) => `${name} proposed a skill change`,
  takeover: (name) => `${name} needs you to take over a computer`,
  trigger_proposal: (name) => `${name} proposed a trigger`,
  wiki_suggestion: (name) => `${name} suggested a wiki edit`,
};

const headingFor = (agentName: string, kind: NeedsYouKind | undefined) =>
  kind === undefined ? agentName : HEADINGS[kind](agentName);

function OpenTaskLink({ runId }: { runId: string }) {
  return (
    <Link
      className={buttonVariants({ size: "sm", variant: "outline" })}
      params={{ runId }}
      to="/tasks/$runId"
    >
      Open task
    </Link>
  );
}

function CardSummary({ card }: { card: DeskCard }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-semibold">{card.title}</p>
      <p className="text-muted-foreground text-xs">{card.band.text}</p>
    </div>
  );
}

/** An ask whose request is not loaded: the title, and a way to the task. */
function AskFallback({ card }: { card: DeskCard }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <CardSummary card={card} />
      {card.runId === undefined ? null : <OpenTaskLink runId={card.runId} />}
    </div>
  );
}

function ThreadBody({ card }: { card: DeskCard }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-muted-foreground text-xs">{card.band.text}</p>
      <Link
        className={buttonVariants({ size: "sm", variant: "outline" })}
        search={{ thread: card.id }}
        to="/inbox"
      >
        Open thread
      </Link>
    </div>
  );
}

interface NeedsYouBodyProps {
  agentName: string;
  card: DeskCard;
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  onChanged: () => void;
  request: RequestView | null;
  version: { number: number; skillId: string } | null;
}

function NeedsYouBody({
  agentName,
  card,
  nowMs,
  onAnswer,
  onChanged,
  request,
  version,
}: NeedsYouBodyProps) {
  switch (card.needsYouKind) {
    case "approval":
    case "question":
    case "takeover":
      return request === null ? (
        <AskFallback card={card} />
      ) : (
        <RequestCard nowMs={nowMs} onAnswer={onAnswer} view={request} />
      );
    case "skill_proposal":
    case "trigger_proposal":
    case "routine_proposal":
      return (
        <div className="flex flex-col gap-3">
          <CardSummary card={card} />
          <ProposalActions
            card={card}
            onChanged={onChanged}
            version={version}
          />
        </div>
      );
    case "inbox_reply":
      return <ThreadBody card={card} />;
    case "wiki_suggestion":
      return (
        <SuggestionReview
          agentName={agentName}
          id={card.id}
          onDecided={onChanged}
        />
      );
    case "library_conflict":
      return <ConflictResolver card={card} onChanged={onChanged} />;
    default:
      return <CardSummary card={card} />;
  }
}

/** A card in the Needs you lane: an ask, a proposal or a thread reply that waits on a person. */
export function NeedsYouCard({
  agentName,
  card,
  nowMs,
  onAnswer,
  onChanged,
  request,
  version,
}: {
  agentName: string;
  card: DeskCard;
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  onChanged: () => void;
  request: RequestView | null;
  version: { number: number; skillId: string } | null;
}) {
  return (
    <section
      className={BOX_CLASS}
      data-kind={card.needsYouKind}
      data-testid="needs-you-card"
    >
      <header className="flex items-center gap-2.5">
        <span
          className={`grid size-[30px] shrink-0 place-items-center rounded-lg font-bold text-white text-xs ${agentTileColour(agentName)}`}
        >
          {agentInitials(agentName)}
        </span>
        <h3 className="font-semibold">
          {headingFor(agentName, card.needsYouKind)}
        </h3>
      </header>
      <NeedsYouBody
        agentName={agentName}
        card={card}
        nowMs={nowMs}
        onAnswer={onAnswer}
        onChanged={onChanged}
        request={request}
        version={version}
      />
    </section>
  );
}
