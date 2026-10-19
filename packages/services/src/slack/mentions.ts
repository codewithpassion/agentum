/** A workspace member that an `@name` in an agent's message can point at. */
export interface MentionPerson {
  /** Other names Slack knows the person by: display name, real name, username. */
  aliases: string[];
  email: string;
  externalUserId: string;
  /** The name shown for the person, or their email when Slack gave none. */
  slackName: string;
}

/** Slack's mention markup for a user. */
export const userMention = (userId: string): string => `<@${userId}>`;

/** Slack's link markup for a channel. */
export const channelMention = (channelId: string): string => `<#${channelId}>`;

/**
 * An `@name` that starts the text or follows a character that cannot end a
 * word, a mention, a link or an address. The name may hold letters of any
 * script, digits, `.`, `_`, `-` and `@`, so a full email address is one name.
 * It keeps its trailing punctuation so the caller can retry without it.
 */
const MENTION = /(?<![\p{L}\p{N}._%+\-/<@|])@([\p{L}\p{N}][\p{L}\p{N}._@-]*)/gu;

const TRAILING_PUNCTUATION = /[._@-]+$/;

const BROADCAST_NAMES: ReadonlySet<string> = new Set([
  "channel",
  "everyone",
  "here",
]);

/** Why a name stays plain text, as the note after the `@name`. */
const UNCONVERTED_NOTES: Record<"broadcast" | "many" | "none", string> = {
  broadcast: "is not converted, sent as plain text",
  many: "matched more than one person, sent as plain text",
  none: "matched nobody, sent as plain text",
};

/** The people each lowercase name stands for, without repeats. */
type NameIndex = Map<string, string[]>;

type Lookup =
  | { kind: "broadcast" }
  | { kind: "many" }
  | { kind: "none" }
  | { kind: "one"; userId: string };

const indexNames = (people: readonly MentionPerson[]): NameIndex => {
  const index: NameIndex = new Map();
  for (const person of people) {
    const [localPart = ""] = person.email.split("@");
    const names = [
      person.email,
      localPart,
      person.slackName,
      ...person.aliases,
    ];
    for (const name of names) {
      const key = name.toLowerCase();
      const ids = index.get(key) ?? [];
      if (!ids.includes(person.externalUserId)) {
        index.set(key, [...ids, person.externalUserId]);
      }
    }
  }
  return index;
};

const lookup = (name: string, index: NameIndex): Lookup => {
  const key = name.toLowerCase();
  if (BROADCAST_NAMES.has(key)) {
    return { kind: "broadcast" };
  }
  const [first, second] = index.get(key) ?? [];
  if (first === undefined) {
    return { kind: "none" };
  }
  if (second !== undefined) {
    return { kind: "many" };
  }
  return { kind: "one", userId: first };
};

/**
 * Turns `@name` into a Slack mention when exactly one person has that name.
 * A name that matches nobody or several people, or is `@here`, `@channel` or
 * `@everyone`, stays as written, and a note says why. Returns the text with
 * the mentions and one note per distinct name, in order of first appearance.
 */
export const convertMentions = (
  text: string,
  people: readonly MentionPerson[]
): { notes: string[]; text: string } => {
  const index = indexNames(people);
  const notes: string[] = [];
  const noted = new Set<string>();
  const note = (name: string, message: string): void => {
    const key = name.toLowerCase();
    if (!noted.has(key)) {
      noted.add(key);
      notes.push(`@${name} ${message}`);
    }
  };

  const converted = text.replace(MENTION, (match, token: string) => {
    // The whole token wins when it names someone. Otherwise retry without trailing punctuation.
    const whole = lookup(token, index);
    const core = token.replace(TRAILING_PUNCTUATION, "");
    const name = whole.kind === "none" ? core : token;
    const result = whole.kind === "none" ? lookup(core, index) : whole;
    const trailing = token.slice(name.length);

    if (result.kind === "one") {
      return `${userMention(result.userId)}${trailing}`;
    }
    note(name, UNCONVERTED_NOTES[result.kind]);
    return match;
  });

  return { notes, text: converted };
};
