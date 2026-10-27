/** Explicit member chips keep agent mentions and ordinary @words separate. */
const MEMBER_ID = /^[A-Za-z0-9_-]{1,200}$/;
const MENTION = /@\[([^\]\r\n]{1,100})\]\(member:([A-Za-z0-9_-]{1,200})\)/g;
export const mentionedMemberIds = (body: string): string[] =>
  [
    ...new Set([...body.matchAll(MENTION)].map((match) => match[2] ?? "")),
  ].slice(0, 10);
export const memberMentionToken = (id: string, name: string): string => {
  if (!MEMBER_ID.test(id)) {
    throw new Error("Invalid member id");
  }
  const label =
    name
      .replaceAll(/[\]\r\n]/g, " ")
      .trim()
      .slice(0, 100) || "Member";
  return `@[${label}](member:${id})`;
};
export const readableMentions = (body: string): string =>
  body.replaceAll(MENTION, (_token, label: string) => `@${label}`);
