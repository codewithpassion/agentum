// The pure helpers behind the Q&A board pages: the list filters, how an
// author reads, and what a form may send.

import type { QaStatus } from "@repo/db/shared";

export type QaFilter = "all" | "answered" | "open";

export const QA_FILTERS: readonly { id: QaFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "answered", label: "Answered" },
  { id: "all", label: "All" },
];

/** The `status` input of `qa.list` for a filter. `all` sends none. */
export const statusOfFilter = (filter: QaFilter): QaStatus | undefined =>
  filter === "all" ? undefined : filter;

export interface QaAuthorFields {
  authorId: string;
  authorKind: "agent" | "user";
  runId: string | null;
}

/** Who wrote a question or an answer, and where to follow it. */
export interface QaAuthor {
  /** Set for an agent. Links to the agent's profile. */
  agentId: string | null;
  kind: "agent" | "person";
  /** "You", "Teammate", the agent's name or "Agent". */
  label: string;
  /** Set when an agent wrote it from a run. Links to the task. */
  runId: string | null;
}

export const authorOf = (
  entry: QaAuthorFields,
  userId: string,
  agentNames: ReadonlyMap<string, string>
): QaAuthor => {
  if (entry.authorKind === "agent") {
    return {
      agentId: entry.authorId,
      kind: "agent",
      label: agentNames.get(entry.authorId) ?? "Agent",
      runId: entry.runId,
    };
  }
  return {
    agentId: null,
    kind: "person",
    label: entry.authorId === userId ? "You" : "Teammate",
    runId: null,
  };
};

export const canSubmitAnswer = (body: string, sending: boolean): boolean =>
  !sending && body.trim().length > 0;

export const canSubmitQuestion = (
  title: string,
  body: string,
  sending: boolean
): boolean => !sending && title.trim().length > 0 && body.trim().length > 0;

const STATUS_LABELS: Record<QaStatus, string> = {
  answered: "Answered",
  closed: "Closed",
  open: "Open",
};

/** "Open", "Answered" or "Closed". */
export const statusLabel = (status: QaStatus): string => STATUS_LABELS[status];

/** The badge variant for a status, in the vocabulary of `Badge`. */
export const STATUS_VARIANT = {
  answered: "secondary",
  closed: "outline",
  open: "default",
} as const satisfies Record<QaStatus, string>;

/** A closed question takes no answers. */
export const takesAnswers = (status: QaStatus): boolean => status !== "closed";

/** Accept stays offered until the answer is the accepted one, and never on a closed question. */
export const canAccept = (
  question: { acceptedAnswerId: string | null; status: QaStatus },
  answerId: string
): boolean =>
  question.status !== "closed" && question.acceptedAnswerId !== answerId;

const PREVIEW_MAX = 160;

/** The first line of a body, for a card's preview. */
export const previewOf = (body: string, max = PREVIEW_MAX): string => {
  const line = body.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
