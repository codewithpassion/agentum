import type { AgentAvatar } from "@repo/db/shared";

export type RoomMemberKind = "agent" | "user";

/** Someone who can write in a room: an agent or a person. */
export interface RoomMember {
  /** Set for agents. A person shows initials. */
  avatar: AgentAvatar | null;
  /**
   * The text after "@" that mentions them: an agent's slug or a person's
   * handle. Null for a person with no handle, who cannot be mentioned.
   */
  handle: string | null;
  id: string;
  kind: RoomMemberKind;
  name: string;
}

/** Everyone the room knows, by `memberKey`. */
export type RoomDirectory = ReadonlyMap<string, RoomMember>;

/** An agent id and a user id may be the same string, so a key has the kind in it. */
export const memberKey = (kind: RoomMemberKind, id: string): string =>
  `${kind}:${id}`;
