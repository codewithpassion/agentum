/**
 * What an agent actually reads when it is woken. It has to carry three things:
 * what was said, where it was said (with the id `post_message` needs), and the
 * fact that a reply only exists if the agent posts it.
 */

export interface WakeEntry {
  authorName: string;
  body: string;
  channelId: string;
  channelKind: "channel" | "dm";
  channelName: string;
  createdAt: number;
  messageId: string;
  threadParentId: string | null;
}

const MAX_BODY_LENGTH = 4000;

const channelLabel = (entry: WakeEntry): string =>
  entry.channelKind === "dm"
    ? `DM with ${entry.channelName}`
    : `#${entry.channelName}`;

const truncate = (body: string): string =>
  body.length <= MAX_BODY_LENGTH
    ? body
    : `${body.slice(0, MAX_BODY_LENGTH)}… [truncated - read the full message with read_channel]`;

const lineFor = (entry: WakeEntry): string => {
  const thread = entry.threadParentId
    ? ` (in the thread under message ${entry.threadParentId})`
    : "";
  return `[${channelLabel(entry)}] ${entry.authorName}${thread}: ${truncate(entry.body)}`;
};

const groupByChannel = (entries: readonly WakeEntry[]): WakeEntry[][] => {
  const groups = new Map<string, WakeEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.channelId) ?? [];
    group.push(entry);
    groups.set(entry.channelId, group);
  }
  return [...groups.values()];
};

const blockFor = (group: readonly WakeEntry[]): string => {
  const [first] = group;
  if (!first) {
    return "";
  }
  return [
    `${channelLabel(first)} — channelId: ${first.channelId}`,
    ...group.map(lineFor),
  ].join("\n");
};

const replyInstruction = (entries: readonly WakeEntry[]): string => {
  const last = entries.at(-1);
  const threadHint = last?.threadParentId
    ? ` The last message is a thread reply, so answer in that thread by passing threadParentId "${last.threadParentId}".`
    : "";
  return `Reply by calling post_message with the channelId shown above the messages you are answering.${threadHint} If nothing here needs a reply from you, do not post - just stop.`;
};

/**
 * Where the reply to a mention belongs. A thread reply stays in its thread; a
 * top-level channel mention starts one, under the message that asked - that
 * keeps the channel readable and puts the answer where the asker is watching.
 * A DM is already one conversation, so replies stay top-level there.
 */
const immediateThreadHint = (entry: WakeEntry): string => {
  if (entry.threadParentId) {
    return ` The message is a thread reply, so answer in that thread by passing threadParentId "${entry.threadParentId}".`;
  }
  if (entry.channelKind === "channel") {
    return ` Answer in a thread under it by passing threadParentId "${entry.messageId}".`;
  }
  return "";
};

/** A single message that named this agent: a mention, or anything in a DM. */
export const composeImmediateWake = (entry: WakeEntry): string =>
  [
    entry.channelKind === "dm"
      ? "You have a new direct message."
      : "You were mentioned in a channel.",
    "",
    blockFor([entry]),
    "",
    `Reply by calling post_message with the channelId shown above the message you are answering.${immediateThreadHint(entry)} If nothing here needs a reply from you, do not post - just stop.`,
  ].join("\n");

/** Everything an agent missed since the last digest, in one wake. */
export const composeDigestWake = (entries: readonly WakeEntry[]): string => {
  const blocks = groupByChannel(entries).map(blockFor);
  return [
    `New messages in your channels (${entries.length} since your last update). You were not mentioned - decide whether any of it needs you.`,
    "",
    blocks.join("\n\n"),
    "",
    replyInstruction(entries),
  ].join("\n");
};
