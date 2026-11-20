import { cn } from "#/lib/utils";
import { AVATAR_CLASSES } from "../roster/roster-logic.ts";
import { agentInitials, agentTileColour } from "../shell/agent-tile.ts";
import type { RoomMember } from "./room-types.ts";

const SIZE_CLASSES = {
  md: "size-8 text-sm",
  sm: "size-6 text-xs",
} as const;

/** A member's tile: the agent's glyph and colour, or a person's initials. */
export function MemberAvatar({
  member,
  size = "md",
}: {
  member: RoomMember;
  size?: keyof typeof SIZE_CLASSES;
}) {
  const colour = member.avatar
    ? AVATAR_CLASSES[member.avatar.color]
    : agentTileColour(member.name);
  const text = member.avatar ? member.avatar.glyph : agentInitials(member.name);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg font-semibold text-white",
        SIZE_CLASSES[size],
        colour
      )}
    >
      {text}
    </span>
  );
}
