import { memberKey, type RoomMember } from "./room-types.ts";

export interface NewTopicInput {
  members: readonly RoomMember[];
  selected: ReadonlySet<string>;
  teamId: string;
  title: string;
}

export interface NewTopicPayload {
  members?: { id: string; kind: RoomMember["kind"] }[];
  teamId: string;
  title: string;
}

/** The body for `inbox.createThread`. No members picked means the whole team. */
export const newTopicInput = ({
  selected,
  teamId,
  title,
  members,
}: NewTopicInput): NewTopicPayload => {
  const payload: NewTopicPayload = { teamId, title: title.trim() };
  if (selected.size === 0) {
    return payload;
  }
  payload.members = members
    .filter((member) => selected.has(memberKey(member.kind, member.id)))
    .map((member) => ({ id: member.id, kind: member.kind }));
  return payload;
};

export const canCreateTopic = (title: string, creating: boolean): boolean =>
  title.trim() !== "" && !creating;
