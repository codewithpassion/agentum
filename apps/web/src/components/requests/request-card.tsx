import { useUser } from "@clerk/tanstack-react-start";
import type { Question } from "@repo/protocol/requests";
import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { isSendShortcut } from "#/components/composer/send-shortcut.ts";
import { tabFocusIndex } from "#/components/task/task-tabs.tsx";
import { Button, buttonVariants } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import {
  type A2aSendFields,
  type AnswerPayload,
  a2aSendFields,
  approvalAnswer,
  canSubmitAnswers,
  expiryText,
  type MailApprovalFields,
  mailApprovalFields,
  offersAlwaysAllow,
  pickQuestion,
  type QuestionInputs,
  questionAnswer,
  type RequestView,
  type Settled,
  settledLine,
  taskSettlement,
  typeQuestion,
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
    return user.fullName ?? user.firstName ?? "you";
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
  radio,
  tabStop,
}: {
  radio: boolean;
  tabStop: boolean;
  choice: string;
  disabled: boolean;
  pressed: boolean;
  onToggle: (choice: string) => void;
}) {
  const handleClick = useCallback(() => onToggle(choice), [choice, onToggle]);
  const keyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!radio) {
        return;
      }
      const buttons = Array.from(
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
          '[role="radio"]'
        ) ?? []
      );
      const key = event.key
        .replace("ArrowDown", "ArrowRight")
        .replace("ArrowUp", "ArrowLeft");
      const next = tabFocusIndex(
        key,
        buttons.indexOf(event.currentTarget),
        buttons.length
      );
      if (next === null) {
        return;
      }
      event.preventDefault();
      buttons[next]?.focus();
      const nextChoice = buttons[next]?.textContent;
      if (
        nextChoice &&
        buttons[next]?.getAttribute("aria-checked") !== "true"
      ) {
        onToggle(nextChoice);
      }
    },
    [radio, onToggle]
  );
  return (
    <Button
      aria-checked={radio ? pressed : undefined}
      aria-pressed={radio ? undefined : pressed}
      className="min-h-10 w-full text-base sm:w-auto sm:text-[0.8rem] md:min-h-9"
      disabled={disabled}
      onClick={handleClick}
      onKeyDown={keyDown}
      role={radio ? "radio" : undefined}
      size="sm"
      tabIndex={radio && !tabStop ? -1 : 0}
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
  onSend,
}: {
  onSend: (event: KeyboardEvent<HTMLInputElement>) => void;
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
        <div
          aria-label={question.question}
          className="flex flex-wrap gap-2"
          role="radiogroup"
        >
          {(question.choices ?? []).map((choice, index) => (
            <ChoiceButton
              choice={choice}
              disabled={disabled}
              key={choice}
              onToggle={pick}
              pressed={picked.includes(choice)}
              radio={!question.multiSelect}
              tabStop={
                picked.length === 0 ? index === 0 : picked.includes(choice)
              }
            />
          ))}
        </div>
      )}
      <Input
        aria-label={`Your own answer to ${question.question}`}
        disabled={disabled}
        onChange={handleText}
        onKeyDown={onSend}
        placeholder="Your own answer"
        value={typed}
      />
    </div>
  );
}

export function QuestionCard({
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
      setInputs((prev) => pickQuestion(prev, question, choice)),
    []
  );

  const type = useCallback(
    (questionText: string, text: string) =>
      setInputs((prev) => typeQuestion(prev, questionText, text)),
    []
  );

  const send = useCallback(
    () => submit(questionAnswer(questions, inputs)),
    [inputs, questions, submit]
  );

  const shortcut = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (
        isSendShortcut({
          ...event,
          isComposing: event.nativeEvent.isComposing,
        }) &&
        canSubmitAnswers(questions, inputs) &&
        !pending
      ) {
        event.preventDefault();
        send();
      }
    },
    [questions, inputs, pending, send]
  );
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
        Answer question
      </h3>
      <p className="text-muted-foreground text-xs">
        {expiryText(view.expiresAt, nowMs)}
      </p>
      {questions.map((question) => (
        <QuestionBlock
          disabled={pending}
          key={question.question}
          onPick={pick}
          onSend={shortcut}
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

function A2aFields({ send }: { send: A2aSendFields }) {
  return (
    <div
      className="flex flex-col gap-2 text-sm"
      data-testid="a2a-approval-fields"
    >
      <p className="text-muted-foreground text-xs">
        To {send.peer} at {send.host}, an agent outside this workspace. This is
        the whole message.
      </p>
      <pre className="whitespace-pre-wrap">{send.text}</pre>
    </div>
  );
}

function ApprovalCard({
  view,
  nowMs,
  onAnswer,
  title,
}: {
  view: Extract<RequestView, { kind: "approval" }>;
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  title?: string;
}) {
  const { error, pending, submit } = useAnswer(view, onAnswer);
  const [note, setNote] = useState("");
  const noteId = useId();
  const { input } = view.display;
  const inputText =
    typeof input === "string" ? input : JSON.stringify(input, null, 2);
  const mail = mailApprovalFields(view.display);
  const a2a = a2aSendFields(view.display);

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
      className="flex flex-col gap-3 border border-warning/40 bg-warning/10 px-3 py-3 text-sm [&_button]:min-h-10 md:[&_button]:min-h-9"
      data-testid="request-card"
    >
      <h3
        className="font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-request-heading
        tabIndex={-1}
      >
        {title ?? view.display.summary}
      </h3>
      <p className="text-muted-foreground text-xs">
        {expiryText(view.expiresAt, nowMs)}
      </p>
      {mail === null && a2a === null ? (
        <details className="text-muted-foreground text-xs">
          <summary className="pointer-coarse:min-h-10 cursor-pointer">
            Input
          </summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">
            {inputText}
          </pre>
        </details>
      ) : null}
      {mail === null ? null : <MailFields mail={mail} />}
      {a2a === null ? null : <A2aFields send={a2a} />}
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
        {offersAlwaysAllow(view.display) ? (
          <div className="flex flex-col gap-1 border-border border-t pt-2 max-sm:order-last sm:border-t-0 sm:pt-0">
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
        ) : null}
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

export function TakeoverCard({
  view,
  nowMs,
  onClosed,
  inControl = false,
  canTake = false,
  onComputer,
}: {
  inControl?: boolean;
  canTake?: boolean;
  onComputer?: () => void;
  view: Extract<RequestView, { kind: "takeover" }>;
  nowMs: number;
  onClosed?: () => void;
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
      onClosed?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, [onClosed, view.id]);
  const take = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await getTrpc().takeover.take.mutate({ requestId: view.id });
      onComputer?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, [onComputer, view.id]);
  if (inControl) {
    return (
      <div className="border border-info/40 bg-info/10 p-3 text-info">
        <h3 data-request-heading tabIndex={-1}>
          You have control
        </h3>
        <p className="text-sm">The agent waits until you hand back.</p>
      </div>
    );
  }
  if (closed) {
    return (
      <p className="text-muted-foreground text-sm">Takeover request closed</p>
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
        Take over the computer
      </h3>
      <p>{view.display.reason}</p>
      <p className="text-muted-foreground text-xs">
        {expiryText(view.expiresAt, nowMs)}
      </p>
      <div className="flex flex-wrap gap-2">
        {onComputer ? (
          <Button disabled={pending || !canTake} onClick={take} type="button">
            Take over
          </Button>
        ) : (
          <Link
            className={buttonVariants({ size: "default" })}
            hash="computer"
            params={{ runId: view.runId }}
            to="/tasks/$runId"
          >
            Open screen
          </Link>
        )}
        <Button
          disabled={pending}
          onClick={cancel}
          type="button"
          variant="outline"
        >
          Cancel request
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

/**
 * `title` replaces an approval's raw "Use <tool>" line when the caller has a
 * plainer one. `onClosed` runs once a takeover request is cancelled here.
 */
export function RequestCard({
  view,
  nowMs,
  onAnswer,
  onClosed,
  title,
  settledAt,
  cancelledByEdit = false,
  inControl,
  canTake,
  onComputer,
}: {
  inControl?: boolean;
  canTake?: boolean;
  onComputer?: () => void;
  settledAt?: string;
  cancelledByEdit?: boolean;
  view: RequestView;
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  onClosed?: () => void;
  title?: string;
}) {
  const { user } = useUser();

  if (view.settled !== null) {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-testid="request-settled"
      >
        {taskSettlement(
          view.kind,
          view.settled,
          settledAt,
          cancelledByEdit,
          settledLine(view.kind, view.settled, answeredBy(view.settled, user))
        )}
      </p>
    );
  }
  if (view.kind === "takeover") {
    return (
      <TakeoverCard
        canTake={canTake}
        inControl={inControl}
        nowMs={nowMs}
        onClosed={onClosed}
        onComputer={onComputer}
        view={view}
      />
    );
  }
  if (view.kind === "approval") {
    return (
      <ApprovalCard
        nowMs={nowMs}
        onAnswer={onAnswer}
        title={title}
        view={view}
      />
    );
  }
  return <QuestionCard nowMs={nowMs} onAnswer={onAnswer} view={view} />;
}
