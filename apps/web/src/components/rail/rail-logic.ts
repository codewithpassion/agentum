const MS_PER_DAY = 86_400_000;
const WEEK_AHEAD_DAYS = 6;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Whole local calendar days since the epoch, so DST shifts cannot move a day. */
function calendarDay(date: Date): number {
  return (
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY
  );
}

/** Due label for a card, judged by local calendar days against `now`. */
export function dueLabel(dueAt: string | null, now: Date): string | null {
  if (dueAt === null) {
    return null;
  }
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) {
    return null;
  }

  const days = calendarDay(due) - calendarDay(now);
  if (days < 0) {
    return "Overdue";
  }
  if (days === 0) {
    return "Due today";
  }
  if (days === 1) {
    return "Due tomorrow";
  }
  if (days <= WEEK_AHEAD_DAYS) {
    return `Due ${WEEKDAYS[due.getDay()]}`;
  }

  const day = due.getDate();
  const month = MONTHS[due.getMonth()];
  const year =
    due.getFullYear() === now.getFullYear() ? "" : ` ${due.getFullYear()}`;
  return `Due ${day} ${month}${year}`;
}

/** Count of cards hidden behind the first one, or null when none are hidden. */
export function extraCardsLabel(cardCount: number): string | null {
  if (cardCount <= 1) {
    return null;
  }
  return `+${cardCount - 1} more`;
}

/** Wording for the open questions row, or null when no question is open. */
export function openQuestionsLabel(count: number): string | null {
  if (count <= 0) {
    return null;
  }
  return count === 1 ? "1 open question" : `${count} open questions`;
}
