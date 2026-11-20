import type { RoomMember, RoomMemberKind } from "./room-types.ts";

export interface MentionToken {
  end: number;
  query: string;
  start: number;
}

const PRECEDING_CHAR_BLOCKER = /[\p{L}\p{N}_@]/u;
const QUERY_PATTERN = /^[A-Za-z0-9-]*$/;
const WORD_BREAK = /[^\p{L}\p{N}]+/u;
const MENTION_PATTERN =
  /(?<![\p{L}\p{N}_@])@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/gu;

const KIND_RANK: Record<RoomMemberKind, number> = { agent: 0, user: 1 };

const byName = (a: RoomMember, b: RoomMember): number =>
  a.name.localeCompare(b.name) ||
  (a.handle ?? "").localeCompare(b.handle ?? "");

const byKindThenName = (a: RoomMember, b: RoomMember): number =>
  KIND_RANK[a.kind] - KIND_RANK[b.kind] || byName(a, b);

/** Lower is a better match. Null means the member does not match. */
const matchRank = (member: RoomMember, query: string): number | null => {
  const handle = (member.handle ?? "").toLowerCase();
  const name = member.name.toLowerCase();
  if (handle.startsWith(query)) {
    return 0;
  }
  if (name.split(WORD_BREAK).some((word) => word.startsWith(query))) {
    return 1;
  }
  if (handle.includes(query) || name.includes(query)) {
    return 2;
  }
  return null;
};

/** The "@" mention the caret is inside, or null when no mention is being typed. */
export const activeMention = (
  text: string,
  caret: number
): MentionToken | null => {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start === -1) {
    return null;
  }
  const precedingChar = Array.from(
    text.slice(Math.max(0, start - 2), start)
  ).at(-1);
  if (
    precedingChar !== undefined &&
    PRECEDING_CHAR_BLOCKER.test(precedingChar)
  ) {
    return null;
  }
  const query = before.slice(start + 1);
  if (!QUERY_PATTERN.test(query)) {
    return null;
  }
  return { end: caret, query, start };
};

/** Members to offer for a query. Members without a handle cannot be mentioned. */
export const mentionOptions = (
  query: string,
  members: readonly RoomMember[],
  limit = 6
): RoomMember[] => {
  const mentionable = members.filter((member) => member.handle !== null);
  if (query === "") {
    return mentionable.sort(byKindThenName).slice(0, limit);
  }
  const needle = query.toLowerCase();
  const ranked: { member: RoomMember; rank: number }[] = [];
  for (const member of mentionable) {
    const rank = matchRank(member, needle);
    if (rank !== null) {
      ranked.push({ member, rank });
    }
  }
  ranked.sort((a, b) => a.rank - b.rank || byName(a.member, b.member));
  return ranked.slice(0, limit).map(({ member }) => member);
};

/** Replaces the token with a mention of `handle` and a trailing space. */
export const insertMention = (
  text: string,
  token: MentionToken,
  handle: string
): { caret: number; text: string } => {
  const mention = `@${handle} `;
  return {
    caret: token.start + mention.length,
    text: text.slice(0, token.start) + mention + text.slice(token.end),
  };
};

/** Members mentioned in `text`, in order of first mention, each once. */
export const mentionedMembers = (
  text: string,
  members: readonly RoomMember[]
): RoomMember[] => {
  const byHandle = new Map<string, RoomMember>();
  for (const member of members) {
    if (member.handle === null) {
      continue;
    }
    const key = member.handle.toLowerCase();
    if (!byHandle.has(key)) {
      byHandle.set(key, member);
    }
  }
  const seen = new Set<string>();
  const found: RoomMember[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const key = match[1]?.toLowerCase();
    if (key === undefined || seen.has(key)) {
      continue;
    }
    const member = byHandle.get(key);
    if (member === undefined) {
      continue;
    }
    seen.add(key);
    found.push(member);
  }
  return found;
};
