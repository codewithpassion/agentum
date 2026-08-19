/**
 * Mention parsing lives in the messaging module rather than the composer, so
 * text arriving from a connector takes exactly the same path as text typed by
 * the user.
 *
 * Agent names contain spaces ("@Chief of Staff"), so mentions cannot be found
 * with a word-character regex - they are matched against the known agent names,
 * longest name first, with word-boundary checks on both ends.
 */

export interface MentionCandidate {
  id: string;
  name: string;
}

export interface ParsedMention {
  id: string;
  /** Index of the `@` that opened the mention. */
  index: number;
  name: string;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && WORD_CHARACTER.test(character);

const matchesAt = (body: string, atIndex: number, name: string): boolean => {
  const start = atIndex + 1;
  const end = start + name.length;
  if (body.slice(start, end).toLowerCase() !== name.toLowerCase()) {
    return false;
  }
  // "@Bob" must not match the candidate "Bo", and "@Bob's" must still match.
  return !isWordCharacter(body[end]);
};

export const parseMentions = (
  body: string,
  candidates: readonly MentionCandidate[]
): ParsedMention[] => {
  const byLongestName = [...candidates]
    .filter((candidate) => candidate.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);

  const found = new Map<string, ParsedMention>();

  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "@") {
      continue;
    }
    // Skip email addresses and handles glued to a word ("foo@bar.com").
    if (isWordCharacter(body[index - 1])) {
      continue;
    }
    const candidate = byLongestName.find((option) =>
      matchesAt(body, index, option.name)
    );
    if (candidate && !found.has(candidate.id)) {
      found.set(candidate.id, {
        id: candidate.id,
        index,
        name: candidate.name,
      });
    }
  }

  return [...found.values()].sort((a, b) => a.index - b.index);
};
