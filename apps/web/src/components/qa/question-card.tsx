import { Link } from "@tanstack/react-router";
import { Badge } from "#/components/ui/badge.tsx";
import type { QaQuestionRecord } from "#/integrations/trpc/types";
import { AuthorLine } from "./author-line.tsx";
import {
  authorOf,
  previewOf,
  STATUS_VARIANT,
  statusLabel,
} from "./qa-logic.ts";

interface QuestionCardProps {
  agentNames: ReadonlyMap<string, string>;
  question: QaQuestionRecord;
  userId: string;
}

export function QuestionCard({
  agentNames,
  question,
  userId,
}: QuestionCardProps) {
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          className="font-medium text-foreground hover:underline"
          params={{ questionId: question.id }}
          to="/qa/$questionId"
        >
          {question.title}
        </Link>
        <Badge variant={STATUS_VARIANT[question.status]}>
          {statusLabel(question.status)}
        </Badge>
      </div>
      <p className="text-muted-foreground text-sm">
        {previewOf(question.body)}
      </p>
      <AuthorLine
        author={authorOf(question, userId, agentNames)}
        createdAt={question.createdAt}
      />
    </article>
  );
}
