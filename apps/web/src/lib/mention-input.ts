/**
 * Composer-side helpers for the @mention popover. The composer never decides
 * what a mention *is* - the server parses the stored body (see
 * `modules/messaging/mentions`); this only drives the autocomplete UI.
 */

/** Agent names contain spaces, so the query runs to the caret, not to a word break. */
const MENTION_QUERY = /(?:^|\s)@([^@\n]*)$/;

export interface MentionQuery {
  query: string;
  /** Index of the `@` that opened the query. */
  start: number;
}

export const mentionQueryAt = (
  text: string,
  caret: number
): MentionQuery | undefined => {
  const match = MENTION_QUERY.exec(text.slice(0, caret));
  if (!match) {
    return;
  }
  const query = match[1] ?? "";
  return { query, start: caret - query.length - 1 };
};

export const applyMention = (
  text: string,
  mention: MentionQuery,
  caret: number,
  name: string
): { caret: number; text: string } => {
  const inserted = `@${name} `;
  return {
    caret: mention.start + inserted.length,
    text: text.slice(0, mention.start) + inserted + text.slice(caret),
  };
};

export const matchMentionCandidates = <T extends { name: string }>(
  candidates: readonly T[],
  query: string
): T[] => {
  const needle = query.toLowerCase();
  return candidates.filter((candidate) =>
    candidate.name.toLowerCase().includes(needle)
  );
};
