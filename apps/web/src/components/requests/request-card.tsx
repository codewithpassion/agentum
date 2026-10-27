import { useUser } from "@clerk/tanstack-react-start";
import type { Question } from "@repo/protocol/requests";
import { Link } from "@tanstack/react-router";
import { type ChangeEvent, useCallback, useId, useState } from "react";
import { Button, buttonVariants } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import {
  type AnswerPayload,
  approvalAnswer,
  canSubmitAnswers,
  expiryText,
  type MailApprovalFields,
  mailApprovalFields,
  type QuestionInputs,
  questionAnswer,
  type RequestView,
  type Settled,
  settledLine,
  toggledChoices,
} from "./request-card-logic.ts";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

type CurrentUser = ReturnType<typeof useUser>["user"];

/** Who answered, as the settled line names them. */
const answeredBy = (settled: Settled, user: CurrentUser): string | null => {
  if (settled.status !== "answered" || settled.answeredBy === null) {
    return null;
  }
  if (settled.answeredBy === user?.id) {
    return user.firstName ?? user.fullName ?? "you";
  }
  return "a teammate";
};

/** Runs an answer, keeps the busy and error state, and reports a rejection. */
function useAnswer(
  view: RequestView,
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (payload: AnswerPayload) => {
      setPending(true);
      setError(null);
      try {
        await onAnswer(view, payload);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setPending(false);
      }
    },
    [onAnswer, view]
  );

  return { error, pending, submit };
}

function ChoiceButton({
  choice,
  disabled,
  pressed,
  onToggle,
}: {
  choice: string;
  disabled: boolean;
  pressed: boolean;
  onToggle: (choice: string) => void;
}) {
  const handleClick = useCallback(() => onToggle(choice), [choice, onToggle]);
  return (
    <Button
      aria-pressed={pressed}
      className="w-full text-base sm:w-auto sm:text-[0.8rem]"
      disabled={disabled}
      onClick={handleClick}
      size="sm"
      type="button"
      variant={pressed ? "default" : "outline"}
    >
      {choice}
    </Button>
  );
}

function QuestionBlock({
  question,
  picked,
  typed,
  disabled,
  onPick,
  onType,
}: {
  question: Question;
  picked: readonly string[];
  typed: string;
  disabled: boolean;
  onPick: (question: Question, choice: string) => void;
  onType: (questionText: string, text: string) => void;
}) {
  const pick = useCallback(
    (choice: string) => onPick(question, choice),
    [onPick, question]
  );
  const handleText = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onType(question.question, event.target.value),
    [onType, question.question]
  );
  return (
    <div className="flex flex-col gap-2">
      {question.header === undefined ? null : (
        <p className="font-medium text-xs">{question.header}</p>
      )}
      <p className="text-sm">{question.question}</p>
      {(question.choices ?? []).length === 0 ? null : (
        <div className="flex flex-wrap gap-2">
          {(question.choices ?? []).map((choice) => (
            <ChoiceButton
              choice={choice}
              disabled={disabled}
              key={choice}
              onToggle={pick}
              pressed={picked.includes(choice)}
            />
          ))}
        </div>
      )}
      <Input
        aria-label={`Your own answer to ${question.question}`}
        disabled={disabled}
        onChange={handleText}
        placeholder="Your own answer"
        value={typed}
      />
    </div>
  );
}

function QuestionCard({
  view,
  nowMs,
  onAnswer,
}: {
  view: Extract<RequestView, { kind: "question" }>;
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
}) {
  const { error, pending, submit } = useAnswer(view, onAnswer);
  const [inputs, setInputs] = useState<QuestionInputs>({
    choices: {},
    text: {},
  });
  const { questions } = view.display;

  const pick = useCallback(
    (question: Question, choice: string) =>
      setInputs((prev) => ({
        ...prev,
        choices: {
          ...prev.choices,
          [question.question]: toggledChoices(
            question,
            prev.choices[question.question] ?? [],
            choice
          ),
        },
      })),
    []
  );

  const type = useCallback(
    (questionText: string, text: string) =>
      setInputs((prev) => ({
        ...prev,
        text: { ...prev.text, [questionText]: text },
      })),
    []
  );

  const send = useCallback(
    () => submit(questionAnswer(questions, inputs)),
    [inputs, questions, submit]
  );

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border px-3 py-2 text-sm"
      data-testid="request-card"
    >
      <p className="text-muted-foreground text-xs">
        {expiryText(view.expiresAt, nowMs)}
      </p>
      {questions.map((question) => (
        <QuestionBlock
          disabled={pending}
          key={question.question}
          onPick={pick}
          onType={type}
          picked={inputs.choices[question.question] ?? []}
          question={question}
          typed={inputs.text[question.question] ?? ""}
        />
      ))}
      <div>
        <Button
          disabled={pending || !canSubmitAnswers(questions, inputs)}
          onClick={send}
          type="button"
        >
          Send answer
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

function MailFields({ mail }: { mail: MailApprovalFields }) {
  return (
    <div
      className="flex flex-col gap-2 text-sm"
      data-testid="mail-approval-fields"
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">From</dt>
        <dd>{mail.from}</dd>
        <dt className="text-muted-foreground">To</dt>
        <dd>{mail.to.join(", ")}</dd>
        {mail.cc.length === 0 ? null : (
          <>
            <dt className="text-muted-foreground">Cc</dt>
            <dd>{mail.cc.join(", ")}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Subject</dt>
        <dd>{mail.subject}</dd>
      </dl>
      <pre className="whitespace-pre-wrap">{mail.body}</pre>
    </div>
  );
}

function ApprovalCard({
  view,
  nowMs,
  onAnswer,
}: {
  view: Extract<RequestView, { kind: "approval" }>;
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
}) {
  const { error, pending, submit } = useAnswer(view, onAnswer);
  const [note, setNote] = useState("");
  const noteId = useId();
  const { input } = view.display;
  const inputText =
    typeof input === "string" ? input : JSON.stringify(input, null, 2);
  const mail = mailApprovalFields(view.display);

  const allowOnce = useCallback(
    () => submit(approvalAnswer("allow_once", note)),
    [note, submit]
  );
  const alwaysAllow = useCallback(
    () => submit(approvalAnswer("always_allow", note)),
    [note, submit]
  );
  const deny = useCallback(
    () => submit(approvalAnswer("deny", note)),
    [note, submit]
  );
  const handleNote = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setNote(event.target.value),
    []
  );

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border px-3 py-2 text-sm"
      data-testid="request-card"
    >
      <p>{view.display.summary}</p>
      <p className="text-muted-foreground text-xs">
        {expiryText(view.expiresAt, nowMs)}
      </p>
      {mail === null ? (
        <details className="text-muted-foreground text-xs">
          <summary className="pointer-coarse:min-h-10 cursor-pointer">
            Input
          </summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">
            {inputText}
          </pre>
        </details>
      ) : (
        <MailFields mail={mail} />
      )}
      <div className="flex flex-col gap-1">
        <Label htmlFor={noteId}>Note for Deny (optional)</Label>
        <Input
          disabled={pending}
          id={noteId}
          onChange={handleNote}
          value={note}
        />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          className="w-full sm:w-auto"
          disabled={pending}
          onClick={allowOnce}
          type="button"
        >
          Allow once
        </Button>
        <div className="flex flex-col gap-1 border-border border-t pt-2 sm:border-t-0 sm:pt-0">
          <Button
            className="w-full sm:w-auto"
            disabled={pending}
            onClick={alwaysAllow}
            type="button"
            variant="outline"
          >
            Always allow
          </Button>
          <p className="text-muted-foreground text-xs sm:hidden">
            Saves a rule if one fits.
          </p>
        </div>
        <Button
          className="w-full sm:w-auto"
          disabled={pending}
          onClick={deny}
          type="button"
          variant="outline"
        >
          Deny
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

function TakeoverCard({
  view,
  nowMs,
}: {
  view: Extract<RequestView, { kind: "takeover" }>;
  nowMs: number;
}) {
  const [pending, setPending] = useState(false);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await getTrpc().takeover.cancel.mutate({ requestId: view.id });
      setClosed(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, [view.id]);
  if (closed) {
    return (
      <p className="text-muted-foreground text-sm">Takeover request closed</p>
    );
  }
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border px-3 py-2 text-sm"
      data-testid="request-card"
    >
      <p>Take over the computer</p>
      <p>{view.display.reason}</p>
      <p className="text-muted-foreground text-xs">
        {expiryText(view.expiresAt, nowMs)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          className={buttonVariants({ size: "default" })}
          hash="computer"
          params={{ runId: view.runId }}
          to="/tasks/$runId"
        >
          Open screen
        </Link>
        <Button
          disabled={pending}
          onClick={cancel}
          type="button"
          variant="outline"
        >
          Cancel
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

export function RequestCard({
  view,
  nowMs,
  onAnswer,
}: {
  view: RequestView;
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
}) {
  const { user } = useUser();

  if (view.settled !== null) {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-testid="request-settled"
      >
        {settledLine(view.kind, view.settled, answeredBy(view.settled, user))}
      </p>
    );
  }
  if (view.kind === "takeover") {
    return <TakeoverCard nowMs={nowMs} view={view} />;
  }
  if (view.kind === "approval") {
    return <ApprovalCard nowMs={nowMs} onAnswer={onAnswer} view={view} />;
  }
  return <QuestionCard nowMs={nowMs} onAnswer={onAnswer} view={view} />;
}
