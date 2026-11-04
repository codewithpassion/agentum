// The logic behind the rail pane: which item is open, what comes next after an
// answer, which view a card gets, and how it reads. Pure: `rail-pane` draws it.

import type {
  DeskCard,
  DeskCardKind,
  RailCard,
  RailItem,
  RailMail,
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

const holdsId = (item: RailItem, id: string): boolean =>
  item.id === id || item.cards.some((card) => card.id === id);

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
  const item = view.needsYou.find((candidate) => holdsId(candidate, itemId));
  return item === undefined ? defaultSelection(view) : { item, kind: "item" };
};

/** Whether an id names a setup step, an item, or a card inside an item in the view. */
export const isListed = (view: Listed, id: string): boolean =>
  view.setup.some((step) => setupItemId(step) === id) ||
  view.needsYou.some((item) => holdsId(item, id));

/**
 * The id the URL names when the view does not list it, so the pane says so and
 * shows no card. `settling` is the id an answer here just moved away from,
 * which the URL has not caught up with yet. Null when nothing is missing.
 */
export const missingItem = (
  view: Listed | null,
  itemId: string | undefined,
  settling: string | undefined
): string | null =>
  view !== null &&
  itemId !== undefined &&
  itemId !== settling &&
  !isListed(view, itemId)
    ? itemId
    : null;

/** The card with this id, from any item in the view. */
export const findCard = (
  view: Listed | null,
  cardId: string
): RailCard | undefined => {
  if (view === null) {
    return;
  }
  return view.needsYou
    .flatMap((item) => item.cards)
    .find((card) => card.id === cardId);
};

/**
 * Whether a send error stays on screen. It stays through the move its own
 * answer makes (`under` is the item that move opened) and goes once a
 * different item is open.
 */
export const keepsSendError = (
  under: string | null | undefined,
  selectedId: string | null
): boolean => under === undefined || under === selectedId;

/**
 * The line under a send that failed. It names the mail when the card is known,
 * and falls back to the plain line when there is no mail.
 */
export const sendFailureText = (
  mail: RailMail | null | undefined,
  error: string
): string => {
  if (mail === null || mail === undefined) {
    return `Allowed, but the mail could not be sent: ${error}`;
  }
  const [recipient] = mail.to;
  const to = recipient === undefined ? "" : ` to ${recipient}`;
  return `Allowed, but the mail "${mail.subject}"${to} could not be sent: ${error}`;
};

/**
 * The list without the cards already answered here, so a poll that lands late
 * cannot bring one back. An item left with no cards goes; the others keep
 * their order and take their id from their first remaining card.
 */
export const pruneAnswered = (
  view: Listed,
  answered: ReadonlySet<string>
): Listed => {
  if (answered.size === 0) {
    return view;
  }
  const needsYou: RailItem[] = [];
  for (const item of view.needsYou) {
    const cards = item.cards.filter((card) => !answered.has(card.id));
    const [first] = cards;
    if (first !== undefined) {
      needsYou.push(
        cards.length === item.cards.length
          ? item
          : { ...item, cards, id: first.id }
      );
    }
  }
  return { needsYou, setup: view.setup };
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
export type CardKind = "mail" | "problem" | "body";

export const cardView = (card: RailCard): CardKind => {
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
    case "artifact_grant":
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
  ...(card.artifactId ? { artifactId: card.artifactId } : {}),
  ...(card.a2a === undefined ? {} : { a2a: card.a2a }),
  agentId: card.agentId,
  at: card.at,
  band: {
    text: card.detail === "" ? card.status : card.detail,
    tone: "waiting",
  },
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
