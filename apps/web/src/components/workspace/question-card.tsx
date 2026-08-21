import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import type { Question } from "#/lib/api";
import { cx } from "#/lib/cx";
import { optionTone, questionCardState } from "#/lib/question-card";
import { useApi } from "#/lib/workspace-context";

/**
 * An agent's question, rendered in place of the message body it was asked as -
 * the body *is* the prompt, so a bubble and a card would say it twice.
 *
 * The card is controlled: everything it shows comes from `question`, and
 * answering hands the server's reply back through `onAnswered` so the one copy
 * of the question - held by the conversation - is what redraws. That is what
 * lets a Slack click, the expiry sweep and this tab's own button all land the
 * same way. Nothing here decides that a deadline has passed; the server closes
 * a question, because closing it is also what wakes the agent.
 */

/** The countdown is a sentence about the future, so it has to keep being true. */
const TICK_MS = 30_000;

const TONE_VARIANTS = {
  danger: "danger",
  neutral: "subtle",
  primary: "primary",
} as const;

function OptionButton({
  chosen,
  disabled,
  onAnswer,
  option,
  question,
}: {
  chosen: boolean;
  disabled: boolean;
  onAnswer: (option: string) => void;
  option: string;
  question: Question;
}) {
  const answer = useCallback(() => onAnswer(option), [onAnswer, option]);
  // Once resolved, only the chosen option keeps its colour; the rest grey out
  // so the card reads as a record rather than a menu.
  const live = question.status === "pending" || chosen;
  const label = chosen ? `✓ ${option}` : option;

  return (
    <Button
      className={cx(chosen && "ring-1 ring-[var(--ws-accent)]")}
      disabled={disabled}
      onClick={answer}
      size="sm"
      variant={live ? TONE_VARIANTS[optionTone(question, option)] : "subtle"}
    >
      {label}
    </Button>
  );
}

function FreeTextAnswer({
  disabled,
  onAnswer,
}: {
  disabled: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [draft, setDraft] = useState("");

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setDraft(event.target.value),
    []
  );

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const answer = draft.trim();
      if (answer !== "") {
        onAnswer(answer);
      }
    },
    [draft, onAnswer]
  );

  return (
    <form className="flex gap-2" onSubmit={submit}>
      <input
        aria-label="Your answer"
        className="ws-focus min-w-0 flex-1 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-bg)] px-2.5 py-1.5 text-[13px] text-[var(--ws-text)] placeholder:text-[var(--ws-muted)]"
        data-testid="question-answer-input"
        disabled={disabled}
        onChange={onChange}
        placeholder="Type your answer"
        value={draft}
      />
      <Button
        disabled={disabled || draft.trim() === ""}
        size="sm"
        type="submit"
        variant="primary"
      >
        Answer
      </Button>
    </form>
  );
}

/** The chosen answer, kept visible once a free-text question is resolved. */
function AnswerQuote({ answer }: { answer: string }) {
  return (
    <p className="m-0 rounded-lg bg-[var(--ws-panel)] px-2.5 py-1.5 text-[13px] text-[var(--ws-text)]">
      {answer}
    </p>
  );
}

export function QuestionCard({
  onAnswered,
  question,
}: {
  /** The server's word on the question, however this attempt turned out. */
  onAnswered: (question: Question) => void;
  question: Question;
}) {
  const api = useApi();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const counting = question.status === "pending" && question.expiresAt !== null;
  useEffect(() => {
    if (!counting) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [counting]);

  const state = questionCardState(question, { busy, now });

  const answer = useCallback(
    (chosen: string) => {
      setBusy(true);
      setError(null);
      (async () => {
        try {
          const result = await api.answerQuestion(question.id, chosen);
          // Won or lost, the server's question view is the truth now: a 409
          // carries the winner's answer, which is what this card should show.
          if (!result.ok) {
            setError(result.error);
          }
          if (result.question) {
            onAnswered(result.question);
          }
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : "Failed to answer."
          );
        } finally {
          setBusy(false);
        }
      })();
    },
    [api, onAnswered, question.id]
  );

  const showInput = state.freeText && state.mode === "pending";
  const showAnswerQuote = state.freeText && question.answer !== null;

  return (
    <section
      className={cx(
        "min-w-0 space-y-2.5 rounded-2xl border px-3.5 py-3",
        state.permission
          ? "border-[var(--ws-warn)] bg-[color-mix(in_oklab,var(--ws-warn)_10%,var(--ws-surface))]"
          : "border-[var(--ws-line)] bg-[var(--ws-surface)]"
      )}
      data-question-status={state.mode}
      data-testid="question-card"
    >
      <p className="m-0 flex flex-wrap items-center gap-1.5 font-medium text-[10px] uppercase tracking-wide">
        <span
          className={
            state.permission
              ? "text-[var(--ws-warn)]"
              : "text-[var(--ws-muted)]"
          }
        >
          {state.permission ? "⚠ Permission request" : "Question"}
        </span>
        {state.expiryLabel ? (
          <span className="text-[var(--ws-muted)] normal-case tracking-normal">
            · {state.expiryLabel}
          </span>
        ) : null}
      </p>

      <p className="m-0 whitespace-pre-wrap text-[14px] text-[var(--ws-text)] leading-6">
        {question.prompt}
      </p>

      {state.freeText ? null : (
        <div className="flex flex-wrap gap-2">
          {(question.options ?? []).map((option) => (
            <OptionButton
              chosen={state.mode !== "pending" && option === question.answer}
              disabled={state.disabled}
              key={option}
              onAnswer={answer}
              option={option}
              question={question}
            />
          ))}
        </div>
      )}

      {showInput ? <FreeTextAnswer disabled={busy} onAnswer={answer} /> : null}
      {showAnswerQuote ? <AnswerQuote answer={question.answer ?? ""} /> : null}

      {state.resolutionLabel ? (
        <p
          className="m-0 text-[11px] text-[var(--ws-muted)]"
          data-testid="question-resolution"
        >
          {state.resolutionLabel}
        </p>
      ) : null}

      {error ? (
        <p className="m-0 text-[11px] text-[var(--ws-danger)]">{error}</p>
      ) : null}
    </section>
  );
}
