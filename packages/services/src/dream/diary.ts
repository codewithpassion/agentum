// The diary is the plain-words entry an owner reads after a dream. It is pure:
// the caller passes the counts, the plan and a lookup of note text. A note the
// lookup returns null for is private (or unknown), so its text is never printed.
import type { DreamCounts, DreamPlan, DreamPlanChange } from "@repo/db/shared";

const NOTHING_CHANGED = "Nothing needed changing.";
const HELD_PREFIX = "These changes wait for your approval. ";
const TEXT_LIMIT = 140;
const MAX_LINES = 12;

const clip = (text: string): string => {
  const characters = Array.from(text);
  if (characters.length <= TEXT_LIMIT) {
    return text;
  }
  return `${characters.slice(0, TEXT_LIMIT).join("")}...`;
};

const plural = (count: number, noun: string): string =>
  count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;

const joinNatural = (parts: string[]): string => {
  if (parts.length <= 1) {
    return parts.join("");
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
};

const capitalize = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const countSentence = (counts: DreamCounts, held: boolean): string => {
  const parts: string[] = [];
  if (counts.added > 0) {
    parts.push(`${held ? "add" : "added"} ${plural(counts.added, "note")}`);
  }
  if (counts.merged > 0) {
    parts.push(`${held ? "merge" : "merged"} ${counts.merged}`);
  }
  if (counts.dropped > 0) {
    parts.push(`${held ? "drop" : "dropped"} ${counts.dropped}`);
  }

  const sentences: string[] = [];
  if (parts.length > 0) {
    const list = joinNatural(parts);
    sentences.push(held ? `Wants to ${list}.` : `${capitalize(list)}.`);
  }
  if (counts.questions > 0) {
    const isOrAre = counts.questions === 1 ? "is" : "are";
    sentences.push(
      `${plural(counts.questions, "question")} ${isOrAre} waiting for you.`
    );
  }
  return sentences.join(" ");
};

type NoteText = (noteId: string) => string | null;
type ChangeOf<A extends DreamPlanChange["action"]> = Extract<
  DreamPlanChange,
  { action: A }
>;

const addLine = (change: ChangeOf<"add">, held: boolean): string => {
  if (change.userScope !== null) {
    return held ? "Would add a private note." : "Added a private note.";
  }
  return `${held ? "Would add" : "Added"}: ${clip(change.text)}`;
};

const mergeLine = (
  change: ChangeOf<"merge">,
  noteText: NoteText,
  held: boolean
): string => {
  const noteIds = [change.keepNoteId, ...change.absorbedNoteIds];
  if (noteIds.some((noteId) => noteText(noteId) === null)) {
    return held ? "Would merge private notes." : "Merged private notes.";
  }
  const verb = held ? "Would merge into one" : "Merged into one";
  return `${verb}: ${clip(change.text)}`;
};

const dropLine = (
  change: ChangeOf<"drop">,
  noteText: NoteText,
  held: boolean
): string => {
  const droppedText = noteText(change.noteId);
  if (droppedText === null) {
    return held ? "Would drop a private note." : "Dropped a private note.";
  }
  const verb = held ? "Would drop" : "Dropped";
  return `${verb}: ${clip(droppedText)}. ${clip(change.reason)}`;
};

const questionLine = (
  change: ChangeOf<"question">,
  noteText: NoteText
): string => {
  if (change.noteIds.some((noteId) => noteText(noteId) === null)) {
    return "Asked a question about a private note.";
  }
  return `Asked: ${clip(change.question)}`;
};

const changeLine = (
  change: DreamPlanChange,
  noteText: NoteText,
  held: boolean
): string => {
  if (change.action === "add") {
    return addLine(change, held);
  }
  if (change.action === "merge") {
    return mergeLine(change, noteText, held);
  }
  if (change.action === "drop") {
    return dropLine(change, noteText, held);
  }
  return questionLine(change, noteText);
};

export const writeDiary = (input: {
  counts: DreamCounts;
  /** Null titles have private or outside evidence and must remain generic. */
  proposals?: readonly (string | null)[];
  plan: DreamPlan;
  held: boolean;
  noteText: (noteId: string) => string | null;
}): string => {
  const { counts, plan, held, noteText, proposals = [] } = input;
  const skillLines = proposals.map((title) =>
    title === null ? "Proposed a skill." : `Proposed a skill: ${clip(title)}`
  );
  const nothingChanged =
    counts.added === 0 &&
    counts.merged === 0 &&
    counts.dropped === 0 &&
    counts.questions === 0;
  if (nothingChanged) {
    return skillLines.length > 0 ? skillLines.join("\n") : NOTHING_CHANGED;
  }

  const summary = `${held ? HELD_PREFIX : ""}${countSentence(counts, held)}`;
  const lines = plan
    .slice(0, MAX_LINES)
    .map((change) => changeLine(change, noteText, held));
  if (plan.length > MAX_LINES) {
    lines.push(`...and ${plan.length - MAX_LINES} more.`);
  }
  return [summary, ...lines, ...skillLines].join("\n");
};
