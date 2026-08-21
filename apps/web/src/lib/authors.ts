import type { Agent, MessageView } from "./api";

export interface AuthorInfo {
  /** Set when the author is an agent, so the UI can open its profile. */
  agentId: string | null;
  color: string;
  imageUrl: string | null;
  isSelf: boolean;
  name: string;
}

const UNKNOWN_COLOR = "#52525b";
const FORMER_MEMBER_NAME = "Former member";
const UNNAMED_MEMBER = "Member";
/** How the scheduler signs the instruction message it posts for a routine. */
const ROUTINE_AUTHOR_PREFIX = "routine:";
/** How the expiry sweep signs the notice that wakes an unanswered agent. */
const QUESTION_AUTHOR_PREFIX = "question:";

const externalLabel = (authorId: string): string => {
  if (authorId.startsWith(ROUTINE_AUTHOR_PREFIX)) {
    return "Routine";
  }
  return authorId.startsWith(QUESTION_AUTHOR_PREFIX) ? "Agentum" : authorId;
};

/**
 * What to call a workspace member on screen. A membership created by the
 * backfill carries an empty email snapshot until somebody asks Clerk for it, so
 * neither field can be trusted to be there - and an empty string is never a
 * name.
 */
export const memberLabel = (member: {
  email: string;
  name: string | null;
}): string => member.name?.trim() || member.email.trim() || UNNAMED_MEMBER;

/**
 * Consecutive messages from the same person share one header. People are
 * grouped by their *member* id, not by `authorId` - which for a user whose
 * membership is gone is `""`, and would otherwise collapse every former member
 * in a channel into one speaker. Those messages each stand alone instead.
 */
export const groupKeyOf = (message: MessageView): string => {
  if (message.authorType !== "user") {
    return `${message.authorType}:${message.authorId}`;
  }
  const memberId = message.author?.memberId ?? "";
  return memberId === "" ? `former:${message.id}` : `user:${memberId}`;
};

/**
 * The signed-in human, as this client knows itself: `memberId` is the caller's
 * `workspace_members` row (from `GET /api/w/:slug`), which is the only identity
 * a message carries for a person - there is no Clerk id to compare against.
 */
export interface Viewer {
  imageUrl: string | null;
  memberId: string | null;
  name: string;
}

export const authorOf = (
  message: MessageView,
  agentsById: Map<string, Agent>,
  viewer: Viewer
): AuthorInfo => {
  if (message.authorType === "agent") {
    const agent = agentsById.get(message.authorId);
    return {
      agentId: agent?.id ?? null,
      color: agent?.avatar ?? UNKNOWN_COLOR,
      imageUrl: null,
      isSelf: false,
      name: agent?.name ?? "Deleted agent",
    };
  }

  // Somebody on a bridged surface: their handle there is all we have of them -
  // except when the "somebody" is this app itself, firing a routine or closing
  // an unanswered question, in which case the row id means nothing on screen.
  if (message.authorType === "external") {
    return {
      agentId: null,
      color: UNKNOWN_COLOR,
      imageUrl: null,
      isSelf: false,
      name: externalLabel(message.authorId),
    };
  }

  const { author } = message;
  if (!author) {
    // A user message with no resolved author is a view that skipped hydration.
    return {
      agentId: null,
      color: UNKNOWN_COLOR,
      imageUrl: null,
      isSelf: false,
      name: FORMER_MEMBER_NAME,
    };
  }

  const isSelf =
    author.memberId !== null && author.memberId === viewer.memberId;
  return {
    agentId: null,
    color: UNKNOWN_COLOR,
    imageUrl: isSelf ? viewer.imageUrl : author.imageUrl,
    isSelf,
    name: isSelf ? viewer.name : author.name,
  };
};
