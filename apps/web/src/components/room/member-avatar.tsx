import { defaultAgentAvatar } from "@repo/db/shared";
import { AgentTile } from "#/components/shell/agent-tile.tsx";
import type { RoomMember } from "./room-types.ts";

/** A member's tile: the agent's glyph and colour, or a person's first letter on a default colour. */
export function MemberAvatar({
  member,
  size = "md",
}: {
  member: RoomMember;
  size?: "md" | "sm";
}) {
  return (
    <AgentTile
      avatar={member.avatar ?? defaultAgentAvatar(member.name)}
      size={size}
    />
  );
}
