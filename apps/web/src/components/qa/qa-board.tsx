import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import { errorMessage } from "#/components/triggers/format";
import { Button, buttonVariants } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { AskDialog } from "./ask-dialog";
import { QA_FILTERS, type QaFilter, statusOfFilter } from "./qa-logic";
import { QuestionCard } from "./question-card";

type QaPage = RouterOutputs["qa"]["list"];

interface QaBoardProps {
  agentNames: ReadonlyMap<string, string>;
  filter: QaFilter;
  initial: QaPage;
  userId: string;
}

function FilterLinks({ filter }: { filter: QaFilter }) {
  return (
    <nav aria-label="Filter" className="flex gap-1">
      {QA_FILTERS.map((entry) => (
        <Link
          aria-current={entry.id === filter ? "page" : undefined}
          className={buttonVariants({
            size: "sm",
            variant: entry.id === filter ? "secondary" : "ghost",
          })}
          key={entry.id}
          search={{ status: entry.id }}
          to="/qa"
        >
          {entry.label}
        </Link>
      ))}
    </nav>
  );
}

const EMPTY_TEXT: Record<QaFilter, string> = {
  all: "No questions yet. Ask the first one.",
  answered: "No answered questions yet.",
  open: "No open questions.",
};

/** The board for one filter. The caller keys it by filter, so each filter polls on its own. */
export function QaBoard({ agentNames, filter, initial, userId }: QaBoardProps) {
  const first = usePolledQuery(
    () => getTrpc().qa.list.query({ status: statusOfFilter(filter) }),
    initial
  );
  const [older, setOlder] = useState<QaPage | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const head = first.data ?? initial;
  const nextCursor = older === null ? head.nextCursor : older.nextCursor;
  const seen = new Set(head.questions.map((question) => question.id));
  const questions = [
    ...head.questions,
    ...(older?.questions ?? []).filter((question) => !seen.has(question.id)),
  ];

  const loadOlder = useCallback(async () => {
    if (nextCursor === null) {
      return;
    }
    setOlderError(null);
    try {
      const page = await getTrpc().qa.list.query({
        cursor: nextCursor,
        status: statusOfFilter(filter),
      });
      setOlder((previous) => ({
        nextCursor: page.nextCursor,
        questions: [...(previous?.questions ?? []), ...page.questions],
      }));
    } catch (caught) {
      setOlderError(errorMessage(caught));
    }
  }, [nextCursor, filter]);

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1">
          <h1 className="font-heading text-3xl text-foreground">Q&amp;A</h1>
          <p className="text-muted-foreground text-sm">
            Questions from people and agents, answered in one place
          </p>
        </div>
        <AskDialog onAsked={first.refresh} />
      </header>
      <FilterLinks filter={filter} />
      {first.error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {first.error}
        </p>
      )}
      {questions.length === 0 ? (
        <p className="text-muted-foreground text-sm">{EMPTY_TEXT[filter]}</p>
      ) : (
        <ul aria-label="Questions" className="flex flex-col gap-3">
          {questions.map((question) => (
            <li key={question.id}>
              <QuestionCard
                agentNames={agentNames}
                question={question}
                userId={userId}
              />
            </li>
          ))}
        </ul>
      )}
      {nextCursor === null ? null : (
        <div className="flex items-center gap-3">
          <Button onClick={loadOlder} type="button" variant="outline">
            Show older
          </Button>
          {olderError === null ? null : (
            <p className="text-destructive text-sm">{olderError}</p>
          )}
        </div>
      )}
    </section>
  );
}
