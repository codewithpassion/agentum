import type { RailCard } from "@repo/db/shared";
import { useCallback } from "react";
import { NeedsYouBody } from "#/components/desk/needs-you-card.tsx";
import {
  type AnswerPayload,
  mailApprovalFields,
  offersAlwaysAllow,
  type RequestView,
} from "#/components/requests/request-card-logic.ts";
import { HowItGotHere } from "./how-it-got-here.tsx";
import { MailDecision } from "./mail-decision.tsx";
import { cardView, deskCardOf, expiryNote } from "./pane-logic.ts";
import { ProblemBody } from "./problem-pane.tsx";

export interface CardActions {
  /** Sends an answer. Rejects with the reason when it fails. */
  onAnswer: (requestId: string, payload: AnswerPayload) => Promise<void>;
  onDismiss: (runId: string) => Promise<void>;
  /** Runs once a card is dealt with, to move on. */
  onDone: (cardId: string) => Promise<void>;
}

/** The Cc addresses of the held mail behind a request. */
const heldMailCc = (request: RequestView | null): string[] => {
  const fields =
    request?.kind === "approval" ? mailApprovalFields(request.display) : null;
  return fields === null ? [] : fields.cc;
};

function CardBody({
  actions,
  card,
  nowMs,
  request,
  version,
  waitingOn,
}: {
  actions: CardActions;
  card: RailCard;
  nowMs: number;
  request: RequestView | null;
  version: { number: number; skillId: string } | null;
  waitingOn: string | null;
}) {
  const { onAnswer, onDismiss, onDone } = actions;
  const answerMail = useCallback(
    async (cardId: string, payload: AnswerPayload) => {
      await onAnswer(cardId, payload);
      await onDone(cardId);
    },
    [onAnswer, onDone]
  );
  const answerView = useCallback(
    async (view: RequestView, payload: AnswerPayload) => {
      await onAnswer(view.id, payload);
      await onDone(view.id);
    },
    [onAnswer, onDone]
  );
  const changed = useCallback(() => {
    onDone(card.id);
  }, [card.id, onDone]);
  const dismiss = useCallback(
    async (runId: string) => {
      await onDismiss(runId);
      await onDone(card.id);
    },
    [card.id, onDismiss, onDone]
  );

  switch (cardView(card)) {
    case "mail":
      return (
        <MailDecision
          card={card}
          cc={heldMailCc(request)}
          expiry={expiryNote(card.expiresAt, nowMs)}
          offerAlways={
            request?.kind === "approval"
              ? offersAlwaysAllow(request.display)
              : true
          }
          onAnswer={answerMail}
          waitingOn={waitingOn}
        />
      );
    case "problem":
      return <ProblemBody card={card} onDismiss={dismiss} />;
    default:
      return (
        <NeedsYouBody
          agentName={card.agentName}
          card={deskCardOf(card)}
          nowMs={nowMs}
          onAnswer={answerView}
          onChanged={changed}
          request={request}
          title={card.status}
          version={version}
        />
      );
  }
}

/** One decision in an item: its title, who it is from, the body for its kind, and how it got here. */
export function CardView({
  actions,
  card,
  first,
  nowMs,
  request,
  version,
  waitingOn,
}: {
  actions: CardActions;
  card: RailCard;
  /** The first card is the page heading; the others sit under it. */
  first: boolean;
  nowMs: number;
  request: RequestView | null;
  version: { number: number; skillId: string } | null;
  waitingOn: string | null;
}) {
  const Heading = first ? "h1" : "h3";
  return (
    <article
      className={
        first ? "flex flex-col gap-3" : "mt-8 flex flex-col gap-3 border-t pt-6"
      }
      data-kind={card.kind}
      data-testid="rail-card"
    >
      <div>
        <Heading
          className={
            first
              ? "font-heading text-3xl text-foreground leading-tight"
              : "font-semibold text-lg"
          }
        >
          {card.title}
        </Heading>
        <p className="mt-1 text-muted-foreground text-sm">
          {card.agentName}
          {card.passedOnBy === null ? "" : `, passed on by ${card.passedOnBy}`}
        </p>
      </div>
      <CardBody
        actions={actions}
        card={card}
        nowMs={nowMs}
        request={request}
        version={version}
        waitingOn={waitingOn}
      />
      <HowItGotHere card={card} />
    </article>
  );
}
