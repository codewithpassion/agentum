import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "#/components/ui/badge.tsx";
import type { QaAuthor } from "./qa-logic.ts";

interface AuthorLineProps {
  author: QaAuthor;
  createdAt: string;
}

export function AuthorLine({ author, createdAt }: AuthorLineProps) {
  return (
    <p className="text-sm">
      {author.agentId === null ? (
        <span className="font-medium">{author.label}</span>
      ) : (
        <Link
          className="font-medium hover:underline"
          params={{ agentId: author.agentId }}
          to="/agents/$agentId"
        >
          {author.label}
        </Link>
      )}{" "}
      {author.agentId === null ? (
        <Badge variant="secondary">Person</Badge>
      ) : (
        <Badge variant="outline">Agent</Badge>
      )}
      {author.runId === null ? null : (
        <>
          {" "}
          <Link
            className="text-muted-foreground text-xs hover:underline"
            params={{ runId: author.runId }}
            to="/tasks/$runId"
          >
            from task
          </Link>
        </>
      )}{" "}
      <time className="text-muted-foreground text-xs" dateTime={createdAt}>
        {formatDistanceToNow(new Date(createdAt), { addSuffix: true })}
      </time>
    </p>
  );
}
