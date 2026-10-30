// The logic behind the rail pane: which item is open, what comes next after an
// answer, which view a card gets, and how it reads. Pure: `rail-pane` draws it.

import type {
  DeskCard,
  DeskCardKind,
  RailCard,
  RailItem,
  RailSetupStep,
  RailView,
} from "@repo/db/shared";
import { RAIL_ESCALATE_AFTER_MS } from "@repo/db/shared";
import { expiryText } from "#/components/requests/request-card-logic.ts";

type Listed = Pick<RailView, "needsYou" | "setup">;

/** The id of a setup step in the rail list. */
export const setupItemId = (step: RailSetupStep): string => `setup:${step}`;

/** What the pane shows: a setup step, or a needs-you item. */
export type Selection =
  | { kind: "item"; item: RailItem }
  | { kind: "setup"; step: RailSetupStep };

const listIds = (view: Listed): string[] => [
  ...view.setup.map(setupItemId),
  ...view.needsYou.map((item) => item.id),
];

const defaultSelection = (view: Listed): Selection | null => {
  const [firstStep] = view.setup;
  if (firstStep !== undefined) {
    return { kind: "setup", step: firstStep };
  }
  const [firstItem] = view.needsYou;
  return firstItem === undefined ? null : { item: firstItem, kind: "item" };
};

/**
 * The selection for an id from the URL or the last view. An id that no longer
 * exists (or none at all) falls back to the first setup step, then the first item.
 * An id may also name a card inside an item.
 */
export const selectItem = (
  view: Listed,
  itemId: string | undefined
): Selection | null => {
  if (itemId === undefined) {
    return defaultSelection(view);
  }
  const step = view.setup.find(
    (candidate) => setupItemId(candidate) === itemId
  );
  if (step !== undefined) {
    return { kind: "setup", step };
  }
  const item = view.needsYou.find(
    (candidate) =>
      candidate.id === itemId ||
      candidate.cards.some((card) => card.id === itemId)
  );
  return item === undefined ? defaultSelection(view) : { item, kind: "item" };
};

/** The id the pane stores for a selection. */
export const selectionId = (selection: Selection): string =>
  selection.kind === "setup" ? setupItemId(selection.step) : selection.item.id;

/**
 * The entry after `currentId` in the list (setup steps first, then items). The
 * last entry gives the one before it. Null when there is no other entry.
 */
export const nextItemId = (view: Listed, currentId: string): string | null => {
  const ids = listIds(view);
  const index = ids.indexOf(currentId);
  if (index === -1) {
    return ids[0] ?? null;
  }
  const after = ids[index + 1];
  if (after !== undefined) {
    return after;
  }
  return index > 0 ? (ids[index - 1] ?? null) : null;
};

/**
 * The id to open once a card is answered. A grouped item keeps its other
 * cards, so it stays put under its first remaining card. A single-card item
 * is gone after the refresh, so the pane moves to the next entry.
 */
export const itemAfterAnswer = (
  view: Listed,
  item: RailItem,
  answeredCardId: string
): string | null => {
  const remaining = item.cards.filter((card) => card.id !== answeredCardId);
  const [first] = remaining;
  return first === undefined ? nextItemId(view, item.id) : first.id;
};

/** Which body a card gets: a problem, a held mail, or the plain body. */
export type CardView = "mail" | "problem" | "body";

export const cardView = (card: RailCard): CardView => {
  if (card.kind === "problem") {
    return "problem";
  }
  if (card.kind === "approval" && card.mail !== null) {
    return "mail";
  }
  return "body";
};

/**
 * "expires in 42 min" when the card expires within the escalation window (4 h).
 * Null when there is no expiry, it is not a time, or it is further off.
 */
export const expiryNote = (
  expiresAt: string | null,
  nowMs: number
): string | null => {
  if (expiresAt === null) {
    return null;
  }
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline) || deadline - nowMs >= RAIL_ESCALATE_AFTER_MS) {
    return null;
  }
  return expiryText(expiresAt, nowMs);
};

const deskKindOf = (kind: RailCard["kind"]): DeskCardKind => {
  switch (kind) {
    case "approval":
    case "question":
    case "takeover":
      return "request";
    case "skill_proposal":
    case "trigger_proposal":
    case "routine_proposal":
      return "proposal";
    case "inbox_reply":
      return "thread";
    case "library_conflict":
      return "conflict";
    default:
      return "request";
  }
};

/** The desk card that the Needs you body draws for a rail card. */
export const deskCardOf = (card: RailCard): DeskCard => ({
  agentId: card.agentId,
  at: card.at,
  band: { text: card.status, tone: "waiting" },
  id: card.id,
  kind: deskKindOf(card.kind),
  lane: "needs_you",
  startedBy: card.passedOnBy ?? card.agentName,
  title: card.title,
  ...(card.kind === "problem" ? {} : { needsYouKind: card.kind }),
  ...(card.runId === null ? {} : { runId: card.runId }),
  ...(card.threadId === null ? {} : { threadId: card.threadId }),
});

/**
 * The lines that say how a card came to be: who started it, who passed it on,
 * and where it stands now.
 */
export const howItGotHere = (
  card: RailCard,
  formatAt: (iso: string) => string
): string[] => {
  const starter =
    card.passedOnBy ??
    (card.mail === null ? card.agentName || "Someone" : "An email");
  const lines = [`${starter} started this ${formatAt(card.at)}.`];
  if (card.passedOnBy !== null) {
    lines.push(`Passed on to ${card.agentName}.`);
  }
  lines.push(`Now: ${card.status}.`);
  return lines;
};
