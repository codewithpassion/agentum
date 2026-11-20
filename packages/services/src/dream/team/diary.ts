// The team diary: what the team dream did, in plain words, for the room. Pure.
// It names notes by their text only when the note is shared, and the caller
// passes only shared notes, so nothing private can reach it.
const TEXT_LIMIT = 140;
const MAX_LIFT_LINES = 8;

const clip = (text: string): string => {
  const characters = Array.from(text);
  return characters.length <= TEXT_LIMIT
    ? text
    : `${characters.slice(0, TEXT_LIMIT).join("")}...`;
};

const plural = (count: number, noun: string): string =>
  count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;

const joinNatural = (parts: readonly string[]): string =>
  parts.length <= 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

export interface TeamDiaryInput {
  /** Member copies forgotten after their note became a team note. */
  copiesForgotten: number;
  digestUpdated: boolean;
  /** Hand-off findings. `asked` is true when the lead was asked to propose a change. */
  friction: { asked: boolean; summary: string }[];
  /** The text of each team note the dream added. */
  lifted: string[];
  /** Names of the members whose notes were read. */
  members: string[];
  questions: number;
  teamName: string;
}

export const writeTeamDiary = (input: TeamDiaryInput): string => {
  const lines: string[] = [];
  if (input.members.length === 0) {
    lines.push(`No member of ${input.teamName} shares notes with the team.`);
  } else {
    lines.push(`Read the shared notes of ${joinNatural(input.members)}.`);
  }
  const done: string[] = [];
  if (input.lifted.length > 0) {
    done.push(`added ${plural(input.lifted.length, "team note")}`);
  }
  if (input.copiesForgotten > 0) {
    done.push(
      `removed ${input.copiesForgotten} member ${input.copiesForgotten === 1 ? "copy" : "copies"}`
    );
  }
  if (input.digestUpdated) {
    done.push("updated the room digest");
  }
  if (done.length > 0) {
    const sentence = joinNatural(done);
    lines.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
  }
  for (const text of input.lifted.slice(0, MAX_LIFT_LINES)) {
    lines.push(`- ${clip(text)}`);
  }
  if (input.questions > 0) {
    lines.push(
      `${plural(input.questions, "question")} for the team owner: members' notes disagree.`
    );
  }
  for (const item of input.friction) {
    lines.push(
      item.asked
        ? `Hand-off: ${clip(item.summary)} The lead was asked to propose a change.`
        : `Hand-off: ${clip(item.summary)}`
    );
  }
  const changed =
    input.lifted.length +
      input.copiesForgotten +
      input.questions +
      input.friction.length >
      0 || input.digestUpdated;
  if (!changed) {
    lines.push("Nothing needed changing.");
  }
  return lines.join("\n");
};
