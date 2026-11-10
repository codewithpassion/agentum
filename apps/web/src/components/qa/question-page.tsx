import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import { Markdown } from "#/components/markdown/markdown";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import type { QaQuestionView } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import { AnswerCard } from "./answer-card";
import { AnswerForm } from "./answer-form";
import { AuthorLine } from "./author-line";
import {
  authorOf,
  canAccept,
  STATUS_VARIANT,
  statusLabel,
  takesAnswers,
} from "./qa-logic";

interface QuestionPageProps {
  agentNames: ReadonlyMap<string, string>;
  initial: QaQuestionView;
  userId: string;
}

/** One question with its answers. The caller keys it by question id. */
export function QuestionPage({
  agentNames,
  initial,
  userId,
}: QuestionPageProps) {
  const questionId = initial.question.id;
  const view = usePolledQuery(
    () => getTrpc().qa.get.query({ questionId }),
    initial
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const { refresh } = view;
  const { answers, question } = view.data ?? initial;

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await action();
        await refresh();
      } catch (caught) {
        setActionError(errorMessage(caught));
      }
    },
    [refresh]
  );
  const close = useCallback(
    () => run(() => getTrpc().qa.close.mutate({ questionId })),
    [run, questionId]
  );
  const accept = useCallback(
    (answerId: string) =>
      run(() => getTrpc().qa.accept.mutate({ answerId, questionId })),
    [run, questionId]
  );

  const asker = authorOf(question, userId, agentNames);
  const error = actionError ?? view.error;

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link
        className="text-muted-foreground text-sm hover:underline"
        search={{ status: undefined }}
        to="/qa"
      >
        All questions
      </Link>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start gap-3">
          <h1 className="min-w-48 flex-1 font-heading text-3xl text-foreground">
            {question.title}
          </h1>
          <Badge variant={STATUS_VARIANT[question.status]}>
            {statusLabel(question.status)}
          </Badge>
          {question.status === "closed" ? null : (
            <Button onClick={close} size="sm" type="button" variant="outline">
              Close question
            </Button>
          )}
        </div>
        <AuthorLine author={asker} createdAt={question.createdAt} />
      </header>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {asker.kind === "agent" ? (
        <div className="text-foreground text-sm">
          <Markdown>{question.body}</Markdown>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-foreground text-sm">
          {question.body}
        </p>
      )}
      <section aria-label="Answers" className="flex flex-col gap-3">
        <h2 className="font-heading text-foreground text-xl">
          {answers.length === 1 ? "1 answer" : `${answers.length} answers`}
        </h2>
        {answers.map((answer) => (
          <AnswerCard
            accepted={question.acceptedAnswerId === answer.id}
            agentNames={agentNames}
            answer={answer}
            key={answer.id}
            onAccept={
              canAccept(question, answer.id) ? () => accept(answer.id) : null
            }
            userId={userId}
          />
        ))}
      </section>
      {takesAnswers(question.status) ? (
        <AnswerForm onAnswered={refresh} questionId={questionId} />
      ) : (
        <p className="text-muted-foreground text-sm">
          This question is closed, so it takes no more answers.
        </p>
      )}
    </section>
  );
}
