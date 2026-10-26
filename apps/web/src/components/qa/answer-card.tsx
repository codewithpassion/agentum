import { Markdown } from "#/components/markdown/markdown.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import type { QaAnswerRecord } from "#/integrations/trpc/types";
import { cn } from "#/lib/utils.ts";
import { AuthorLine } from "./author-line.tsx";
import { authorOf } from "./qa-logic.ts";

interface AnswerCardProps {
  accepted: boolean;
  agentNames: ReadonlyMap<string, string>;
  answer: QaAnswerRecord;
  onAccept: (() => void) | null;
  userId: string;
}

export function AnswerCard({
  accepted,
  agentNames,
  answer,
  onAccept,
  userId,
}: AnswerCardProps) {
  const author = authorOf(answer, userId, agentNames);
  return (
    <article
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card p-4",
        accepted && "border-primary ring-1 ring-primary"
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <AuthorLine author={author} createdAt={answer.createdAt} />
        {accepted ? <Badge variant="default">Accepted</Badge> : null}
      </div>
      {author.kind === "agent" ? (
        <div className="text-foreground text-sm">
          <Markdown>{answer.body}</Markdown>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-foreground text-sm">
          {answer.body}
        </p>
      )}
      {onAccept === null ? null : (
        <div>
          <Button onClick={onAccept} size="sm" type="button" variant="outline">
            Accept answer
          </Button>
        </div>
      )}
    </article>
  );
}
