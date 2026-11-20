import { RAIL_REFRESH_EVENT } from "@repo/db/shared";
import type { Decision } from "@repo/protocol/requests";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import {
  answeredCount,
  type DecisionInputs,
  EMPTY_DECISION_INPUTS,
  pickDecision,
  pressedOption,
  progressText,
  stagedDecisions,
  typeDecision,
} from "./decisions-logic.ts";
import type { RequestView } from "./request-card-logic.ts";
import { expiryText } from "./request-card-logic.ts";

type DecisionsView = Extract<RequestView, { kind: "decisions" }>;

const SETTLED_TEXT = {
  answered: "All answered",
  dismissed: "Dismissed",
} as const;

function OptionButton({
  disabled,
  onPick,
  option,
  pressed,
}: {
  disabled: boolean;
  onPick: (option: string) => void;
  option: string;
  pressed: boolean;
}) {
  const handleClick = useCallback(() => onPick(option), [onPick, option]);
  return (
    <Button
      aria-pressed={pressed}
      className="min-h-10 w-full text-base sm:w-auto sm:text-[0.8rem] md:min-h-9"
      disabled={disabled}
      onClick={handleClick}
      size="sm"
      type="button"
      variant={pressed ? "default" : "outline"}
    >
      {option}
    </Button>
  );
}

function DecisionBlock({
  question,
  pressed,
  typed,
  disabled,
  onPick,
  onType,
}: {
  question: Decision;
  pressed: string | undefined;
  typed: string;
  disabled: boolean;
  onPick: (questionId: string, option: string) => void;
  onType: (questionId: string, text: string) => void;
}) {
  const pick = useCallback(
    (option: string) => onPick(question.id, option),
    [onPick, question.id]
  );
  const handleText = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onType(question.id, event.target.value),
    [onType, question.id]
  );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">{question.text}</p>
      {/* biome-ignore lint/a11y/useSemanticElements: The options are a group of toggle buttons, and a fieldset would add its own border and legend. */}
      <div
        aria-label={question.text}
        className="flex flex-wrap gap-2"
        role="group"
      >
        {question.options.map((option) => (
          <OptionButton
            disabled={disabled}
            key={option}
            onPick={pick}
            option={option}
            pressed={option === pressed}
          />
        ))}
      </div>
      {question.freeText === true ? (
        <Input
          aria-label={`Your own answer to ${question.text}`}
          disabled={disabled}
          onChange={handleText}
          placeholder="Your own answer"
          value={typed}
        />
      ) : null}
    </div>
  );
}

export function DecisionsCard({
  view,
  nowMs,
  onSend,
  onDismiss,
  onClosed,
}: {
  view: DecisionsView;
  nowMs: number;
  onSend: (
    decisions: Record<string, string>
  ) => Promise<{ complete: boolean; given: Record<string, string> }>;
  onDismiss: () => Promise<void>;
  onClosed?: () => void;
}) {
  const [given, setGiven] = useState<Readonly<Record<string, string>>>(
    view.given
  );
  // Answers saved by someone else, or learned after the card opened, join those already known.
  useEffect(() => {
    setGiven((prev) => ({ ...prev, ...view.given }));
  }, [view.given]);
  const [inputs, setInputs] = useState<DecisionInputs>(EMPTY_DECISION_INPUTS);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<keyof typeof SETTLED_TEXT | null>(
    null
  );
  const { display } = view;
  const staged = stagedDecisions(display, given, inputs);
  const canSend = !pending && Object.keys(staged).length > 0;

  const pick = useCallback(
    (questionId: string, option: string) =>
      setInputs((prev) => pickDecision(prev, questionId, option)),
    []
  );
  const type = useCallback(
    (questionId: string, text: string) =>
      setInputs((prev) => typeDecision(prev, questionId, text)),
    []
  );

  const send = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const result = await onSend(stagedDecisions(display, given, inputs));
      setGiven((prev) => ({ ...prev, ...result.given }));
      setInputs(EMPTY_DECISION_INPUTS);
      if (result.complete) {
        setOutcome("answered");
        onClosed?.();
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, [display, given, inputs, onClosed, onSend]);

  const dismiss = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await onDismiss();
      setOutcome("dismissed");
      onClosed?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, [onClosed, onDismiss]);

  if (outcome !== null) {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-testid="request-settled"
      >
        {SETTLED_TEXT[outcome]}
      </p>
    );
  }
  return (
    <div
      className="flex flex-col gap-3 border border-warning/40 bg-warning/10 px-3 py-3 text-sm [&_button]:min-h-10 md:[&_button]:min-h-9"
      data-testid="request-card"
    >
      <h3
        className="font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-request-heading
        tabIndex={-1}
      >
        Decisions
      </h3>
      <p className="text-muted-foreground text-xs">
        {expiryText(view.expiresAt, nowMs)}
      </p>
      <p className="text-muted-foreground text-xs" role="status">
        {progressText(
          answeredCount(display, given, inputs),
          display.questions.length
        )}
      </p>
      {display.questions.map((question) => (
        <DecisionBlock
          disabled={pending}
          key={question.id}
          onPick={pick}
          onType={type}
          pressed={pressedOption(given[question.id], inputs, question.id)}
          question={question}
          typed={inputs.typed[question.id] ?? ""}
        />
      ))}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!canSend} onClick={send} type="button">
          Send answers
        </Button>
        <Button
          disabled={pending}
          onClick={dismiss}
          type="button"
          variant="outline"
        >
          Dismiss
        </Button>
      </div>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The live card: sends answers and dismisses through the tRPC client. */
export function LiveDecisionsCard({
  view,
  nowMs,
  onClosed,
}: {
  view: DecisionsView;
  nowMs: number;
  onClosed?: () => void;
}) {
  const onSend = useCallback(
    async (decisions: Record<string, string>) => {
      const record = await getTrpc().requests.answerDecisions.mutate({
        decisions,
        requestId: view.id,
      });
      return {
        complete: record.status === "answered",
        given:
          record.answer && "decisions" in record.answer
            ? record.answer.decisions
            : {},
      };
    },
    [view.id]
  );
  const onDismiss = useCallback(async () => {
    await getTrpc().requests.dismissDecisions.mutate({ requestId: view.id });
  }, [view.id]);
  // A card drawn from an event alone has no saved answers. The pending list has them.
  const [saved, setSaved] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    let active = true;
    getTrpc()
      .requests.pending.query({})
      .then((records) => {
        const record = records.find(({ id }) => id === view.id);
        if (active && record?.answer && "decisions" in record.answer) {
          setSaved(record.answer.decisions);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [view.id]);
  const current = useMemo(
    () => ({ ...view, given: { ...view.given, ...saved } }),
    [saved, view]
  );
  const closed = useCallback(() => {
    window.dispatchEvent(new Event(RAIL_REFRESH_EVENT));
    onClosed?.();
  }, [onClosed]);
  return (
    <DecisionsCard
      nowMs={nowMs}
      onClosed={closed}
      onDismiss={onDismiss}
      onSend={onSend}
      view={current}
    />
  );
}
