import {
  NEEDS_YOU_HEADINGS,
  RAIL_ESCALATE_AFTER_MS,
  type RailItem,
  type RailItemKind,
} from "@repo/db/shared";
import { PLATFORM_TOOL_LABELS } from "../agent-profile/ask-before.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_EAST_OFFSET_MS = 14 * HOUR_MS;

const LEADING_REPLY_RE = /^\s*(?:(?:re|fwd|fw)\s*:\s*)+/i;

/** The subject without leading Re:, Fwd: or Fw:. */
export const mailTitle = (subject: string): string =>
  subject.replace(LEADING_REPLY_RE, "").trim();

const FREE_MAIL = new Set([
  "163.com",
  "aol.com",
  "bigpond.com",
  "gmail.com",
  "gmx.com",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.co.uk",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mac.com",
  "mail.com",
  "me.com",
  "msn.com",
  "optusnet.com.au",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "yahoo.com",
  "yahoo.com.au",
  "yahoo.co.uk",
  "yandex.com",
  "ymail.com",
  "zoho.com",
  "fastmail.com",
]);

/** The company domain of a recipient list, or the full address for free mail. */
export const groupKey = (toAddresses: readonly string[]): string | null => {
  const keys = new Set<string>();
  for (const raw of toAddresses) {
    const address = raw.trim().toLowerCase();
    const at = address.lastIndexOf("@");
    if (at <= 0 || at === address.length - 1) {
      continue;
    }
    const domain = address.slice(at + 1);
    keys.add(FREE_MAIL.has(domain) ? address : domain);
  }
  return keys.size === 0 ? null : [...keys].sort().join(",");
};

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const URGENT_RE = /\b(?:urgent|asap)\b/;
const TODAY_RE = /\btoday\b/;
const TOMORROW_RE = /\btomorrow\b/;
const BY_WEEKDAY_RE =
  /\bby\s+(?:(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:am|pm)\s+|(?:[01]?\d|2[0-3]):[0-5]\d\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g;
const BY_DATE_RE =
  /\bby\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b(?:\s+(\d{4})\b)?/g;
const TIME_RE =
  /\b(?:(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)|([01]?\d|2[0-3]):([0-5]\d))\b/;
const WHITESPACE_RE = /\s+/;

const mod = (n: number, m: number): number => ((n % m) + m) % m;

/** The viewer's UTC offset, read from their local midnight. Range (-12h, +14h]. */
const viewerOffsetMs = (dayStart: string): number => {
  const offset = mod(-mod(Date.parse(dayStart), DAY_MS), DAY_MS);
  return offset > MAX_EAST_OFFSET_MS ? offset - DAY_MS : offset;
};

/** The viewer's local calendar date of an instant, as UTC midnight of that date. */
const calendarDay = (instant: number, offset: number): number => {
  const local = new Date(instant + offset);
  return Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate()
  );
};

/** Minutes after local midnight of the first time in the text, or null. */
const timeMinutes = (lower: string): number | null => {
  const match = TIME_RE.exec(lower);
  if (!match) {
    return null;
  }
  if (match[3] !== undefined) {
    const hour = (Number(match[1] ?? 0) % 12) + (match[3] === "pm" ? 12 : 0);
    return hour * 60 + Number(match[2] ?? 0);
  }
  return Number(match[4] ?? 0) * 60 + Number(match[5] ?? 0);
};

/** A "by <day> <month> [<year>]" match as a calendar day, or null when it is not a real date. */
const explicitDay = (
  dayText: string,
  monthName: string,
  yearText: string | undefined,
  messageDay: number
): number | null => {
  const dayOfMonth = Number(dayText);
  const month = MONTHS.findIndex(
    (name) => name === monthName || name.slice(0, 3) === monthName
  );
  let year =
    yearText === undefined
      ? new Date(messageDay).getUTCFullYear()
      : Number(yearText);
  let day = Date.UTC(year, month, dayOfMonth);
  if (yearText === undefined && day < messageDay) {
    year += 1;
    day = Date.UTC(year, month, dayOfMonth);
  }
  const check = new Date(day);
  return check.getUTCMonth() === month && check.getUTCDate() === dayOfMonth
    ? day
    : null;
};

/**
 * The due time of a message, from words like "urgent", "tomorrow", "by Friday"
 * or "by 30 November". The earliest candidate wins, and past dates still count.
 */
export const dueFrom = (
  text: string,
  ctx: { dayStart: string; messageAt: string }
): string | null => {
  const offset = viewerOffsetMs(ctx.dayStart);
  const lower = text.toLowerCase();
  const messageDay = calendarDay(Date.parse(ctx.messageAt), offset);
  const minutes = timeMinutes(lower);

  const endOf = (day: number): number => day + DAY_MS - offset - 1;
  const onDay = (day: number): number =>
    minutes === null ? endOf(day) : day - offset + minutes * MINUTE_MS;

  const candidates: number[] = [];
  if (URGENT_RE.test(lower)) {
    candidates.push(endOf(messageDay));
  }
  if (TODAY_RE.test(lower)) {
    candidates.push(onDay(messageDay));
  }
  if (TOMORROW_RE.test(lower)) {
    candidates.push(onDay(messageDay + DAY_MS));
  }
  const messageWeekday = new Date(messageDay).getUTCDay();
  for (const match of lower.matchAll(BY_WEEKDAY_RE)) {
    const target = WEEKDAYS.indexOf(match[1] ?? "");
    const ahead = mod(target - messageWeekday, 7);
    candidates.push(onDay(messageDay + ahead * DAY_MS));
  }
  for (const match of lower.matchAll(BY_DATE_RE)) {
    const day = explicitDay(
      match[1] ?? "",
      match[2] ?? "",
      match[3],
      messageDay
    );
    if (day !== null) {
      candidates.push(onDay(day));
    }
  }

  if (candidates.length === 0) {
    return null;
  }
  return new Date(Math.min(...candidates)).toISOString();
};

export interface CardFacts {
  agentName: string;
  kind: RailItemKind;
  /** Set only for a held outgoing mail approval. recipientName is the first recipient's display name when known. */
  mail: {
    recipientName: string | null;
    subject: string;
    to: readonly string[];
  } | null;
  /** Set only on kind "problem". */
  problem?: "bounced" | "failed" | "interrupted" | null;
  /** The existing desk title; kept for every kind except approvals. */
  title: string;
  toolKey: string | null;
  toolName: string | null;
}

const SEPARATOR_RE = /[_-]+/g;

const afterLast = (text: string, separator: string): string => {
  const index = text.lastIndexOf(separator);
  return index < 0 ? text : text.slice(index + separator.length);
};

const labelFor = (toolKey: string | null): string | null => {
  if (!(toolKey && Object.hasOwn(PLATFORM_TOOL_LABELS, toolKey))) {
    return null;
  }
  return PLATFORM_TOOL_LABELS[toolKey] ?? null;
};

/** A tool name as words: "xero/create_bill" becomes "create bill". */
const toolWords = (toolKey: string | null, toolName: string | null): string => {
  const source = toolKey || toolName || "";
  const words = afterLast(afterLast(source, "/"), "__")
    .replace(SEPARATOR_RE, " ")
    .trim();
  return words || "using a tool";
};

const recipientWho = (mail: NonNullable<CardFacts["mail"]>): string => {
  const first = mail.recipientName?.trim().split(WHITESPACE_RE)[0];
  if (first) {
    return first;
  }
  const address = mail.to[0]?.trim();
  return address || "them";
};

/** The card's heading in plain words. */
export const plainTitle = (card: CardFacts): string => {
  if (card.kind !== "approval") {
    return card.title;
  }
  if (card.mail) {
    const who = recipientWho(card.mail);
    const subject = mailTitle(card.mail.subject);
    return subject ? `Reply to ${who}: ${subject}` : `Reply to ${who}`;
  }
  const label =
    labelFor(card.toolKey) ?? toolWords(card.toolKey, card.toolName);
  return `${card.agentName} asks before ${label}`;
};

const problemStatus = (problem: CardFacts["problem"]): string => {
  switch (problem) {
    case "bounced":
      return "Mail bounced";
    case "interrupted":
      return "Stopped part way";
    default:
      return "Failed";
  }
};

/**
 * The one sentence a problem card shows. A bounce keeps the desk's own line,
 * which names the address ("Mail to ada@example.com bounced"). Anything else
 * names the agent.
 */
export const problemDetail = (input: {
  agentName: string;
  bandText: string;
  problem: CardFacts["problem"];
}): string =>
  input.problem === "bounced"
    ? input.bandText
    : `${input.agentName || "This work"} stopped before finishing`;

/** What happened to the card, in plain words. */
export const plainStatus = (card: CardFacts): string => {
  if (card.kind === "approval") {
    return card.mail ? "Reply ready" : "Needs your OK";
  }
  if (card.kind === "problem") {
    return problemStatus(card.problem);
  }
  return NEEDS_YOU_HEADINGS[card.kind](card.agentName);
};

/** Who an agent asks: owner, else its creator. Null when the member list is known and does not hold them. */
export const assigneeOf = (
  agent: { createdBy: string; ownerUserId: string | null },
  memberIds: ReadonlySet<string> | null
): string | null => {
  const who = agent.ownerUserId ?? agent.createdBy;
  if (!who) {
    return null;
  }
  return memberIds === null || memberIds.has(who) ? who : null;
};

/** True once the item is RAIL_ESCALATE_AFTER_MS old or older. */
export const isEscalated = (at: string, now: Date): boolean =>
  now.getTime() - Date.parse(at) >= RAIL_ESCALATE_AFTER_MS;

/** The backup who is also asked: set only when escalated, the backup differs from the assignee, and the backup is a known member (memberIds null counts as known). */
export const escalationTarget = (input: {
  assigneeUserId: string | null;
  at: string;
  backupUserId: string | null;
  memberIds: ReadonlySet<string> | null;
  now: Date;
}): string | null => {
  const { assigneeUserId, at, backupUserId, memberIds, now } = input;
  if (
    !backupUserId ||
    backupUserId === assigneeUserId ||
    !isEscalated(at, now)
  ) {
    return null;
  }
  return memberIds === null || memberIds.has(backupUserId)
    ? backupUserId
    : null;
};

/**
 * Mine: I am the assignee, or escalated to me, or nobody is asked (assignee null),
 * or the member lookup failed (memberLookupFailed true), or the item is in a run
 * only I can see (ownedByMe true).
 */
export const isMine = (input: {
  assigneeUserId: string | null;
  escalatedToMe: boolean;
  memberLookupFailed: boolean;
  ownedByMe?: boolean;
  userId: string;
}): boolean =>
  input.assigneeUserId === input.userId ||
  input.escalatedToMe ||
  input.assigneeUserId === null ||
  input.memberLookupFailed ||
  input.ownedByMe === true;

const openedAt = (item: RailItem): number =>
  Date.parse(item.cards.at(0)?.at ?? "");

const compareItems = (a: RailItem, b: RailItem): number => {
  if (a.dueAt && b.dueAt) {
    return (
      Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id)
    );
  }
  if (a.dueAt || b.dueAt) {
    return a.dueAt ? -1 : 1;
  }
  return openedAt(a) - openedAt(b) || a.id.localeCompare(b.id);
};

/** Soonest dueAt first; items without one after, oldest first; ties by id. Returns a new array. */
export const sortNeedsYou = (items: readonly RailItem[]): RailItem[] =>
  [...items].sort(compareItems);
