import type { KeyChip, ReceiptStep, ReceiptStepKind } from "@repo/db/shared";
import { Fragment } from "react";
import { bandClass } from "#/components/desk/desk-logic.ts";
import { ExpandableText } from "#/components/expandable-text/expandable-text.tsx";
import { RequestCard } from "#/components/requests/request-card.tsx";
import type {
  AnswerPayload,
  RequestView,
} from "#/components/requests/request-card-logic.ts";
import {
  agentInitials,
  agentTileColour,
} from "#/components/shell/agent-tile.ts";
import {
  chipText,
  countText,
  kindLabel,
  stepTime,
  stepTone,
} from "./task-logic.ts";

const CARD_CLASS =
  "overflow-hidden rounded-lg border bg-card text-card-foreground";
const PAUSED_CLASS = "border-warning ring-4 ring-warning/20";
const REQUEST_BOX_CLASS =
  "flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm";

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

const timeText = (iso: string | null): string | null =>
  iso === null ? null : TIME_FORMAT.format(new Date(iso));

function StepTile({
  agentName,
  kind,
}: {
  agentName: string;
  kind: ReceiptStepKind;
}) {
  if (kind === "trigger") {
    return (
      <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-muted font-bold text-muted-foreground text-xs">
        →
      </span>
    );
  }
  return (
    <span
      className={`grid size-[30px] shrink-0 place-items-center rounded-lg font-bold text-white text-xs ${agentTileColour(agentName)}`}
    >
      {agentInitials(agentName)}
    </span>
  );
}

function KeyChips({ chips, label }: { chips: KeyChip[]; label: string }) {
  if (chips.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5 text-xs">
      <span className="w-5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      {chips.map((chip) => (
        <span
          className="inline-flex min-w-0 max-w-full overflow-hidden rounded-md border text-xs"
          key={`${chip.key}=${chip.value}`}
          title={chipText(chip)}
        >
          <b className="shrink-0 bg-muted px-1.5 py-0.5 font-medium font-mono text-muted-foreground">
            {chip.key}
          </b>
          <span className="min-w-0 truncate bg-card px-1.5 py-0.5">
            {chip.value}
          </span>
        </span>
      ))}
    </div>
  );
}

function ReceiptCard({
  agentName,
  nowMs,
  onAnswer,
  request,
  startedAt,
  step,
}: {
  agentName: string;
  nowMs: number | null;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  request: RequestView | undefined;
  startedAt: string | null;
  step: ReceiptStep;
}) {
  // The local time differs between server and browser, so it shows after mount.
  const time = nowMs === null ? null : timeText(startedAt);
  const subtitle =
    time === null ? kindLabel(step.kind) : `${kindLabel(step.kind)} · ${time}`;
  const paused = step.state === "paused";
  const showRequest = request !== undefined && nowMs !== null;
  const showBand = step.detail !== "" && !(paused && showRequest);

  return (
    <div
      className={paused ? `${CARD_CLASS} ${PAUSED_CLASS}` : CARD_CLASS}
      data-state={step.state}
      data-testid="receipt-step"
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <StepTile agentName={agentName} kind={step.kind} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{`${step.index}. ${step.title}`}</div>
          <div className="truncate text-muted-foreground text-xs">
            {subtitle}
          </div>
        </div>
        {paused ? (
          <span className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 font-medium text-warning text-xs">
            Needs you
          </span>
        ) : null}
      </div>
      <KeyChips chips={step.in} label="in" />
      <KeyChips chips={step.out} label="out" />
      {showBand ? (
        <ExpandableText
          className={`whitespace-pre-wrap border-t px-3 py-1.5 text-xs ${bandClass(stepTone(step.state))}`}
          lines={3}
        >
          {step.detail}
        </ExpandableText>
      ) : null}
      {request !== undefined && nowMs !== null ? (
        <div className="p-3">
          <div className={REQUEST_BOX_CLASS}>
            <RequestCard nowMs={nowMs} onAnswer={onAnswer} view={request} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReceiptLink({
  countToNext,
}: {
  countToNext: ReceiptStep["countToNext"];
}) {
  return (
    <div className="relative flex h-[34px] flex-col items-center">
      <span
        className={`w-0.5 flex-1 bg-emerald-600 ${countToNext === null ? "opacity-50" : ""}`}
      />
      {countToNext === null ? null : (
        <span
          className="absolute top-1/2 left-[calc(50%+10px)] -translate-y-1/2 whitespace-nowrap rounded-full border border-emerald-600 bg-card px-2 py-px text-[11px] text-emerald-700 dark:text-emerald-400"
          data-testid="receipt-count"
        >
          {countText(countToNext)}
        </span>
      )}
    </div>
  );
}

/** The receipt of a task: one card per step, joined by links that count what moved on. */
export function Receipt({
  agentName,
  events,
  nowMs,
  onAnswer,
  requests,
  steps,
}: {
  agentName: string;
  events: readonly { createdAt: string; id: string }[];
  nowMs: number | null;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  requests: ReadonlyMap<string, RequestView>;
  steps: ReceiptStep[];
}) {
  return (
    <section aria-label="Receipt" className="flex min-w-0 flex-col">
      <div className="mb-2 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
        Receipt
      </div>
      {steps.map((step, index) => (
        <Fragment key={step.index}>
          <ReceiptCard
            agentName={agentName}
            nowMs={nowMs}
            onAnswer={onAnswer}
            request={
              step.requestId === undefined
                ? undefined
                : requests.get(step.requestId)
            }
            startedAt={stepTime(step, events)}
            step={step}
          />
          {index < steps.length - 1 ? (
            <ReceiptLink countToNext={step.countToNext} />
          ) : null}
        </Fragment>
      ))}
    </section>
  );
}
