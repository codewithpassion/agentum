import type { AgentAvatar, AgentAvatarColor } from "@repo/db/shared";
import { cn } from "#/lib/utils";

/** Whole class names, so Tailwind finds them. */
export const AVATAR_CLASSES: Readonly<Record<AgentAvatarColor, string>> = {
  amber: "bg-amber-600",
  blue: "bg-blue-600",
  green: "bg-emerald-600",
  orange: "bg-orange-600",
  red: "bg-rose-600",
  slate: "bg-slate-600",
  teal: "bg-teal-600",
  violet: "bg-violet-600",
};

/** Whole class names, so Tailwind finds them. */
export const AGENT_TILE_SIZES = {
  lg: "size-10 rounded-lg text-base",
  md: "size-8 rounded-lg text-sm",
  sm: "size-6 rounded-lg text-xs",
  xl: "size-[52px] rounded-xl text-lg",
  xs: "size-[1.125rem] rounded text-[9px]",
} as const;

/** An agent's tile: the colour and glyph stored on the agent, the same everywhere it shows. */
export function AgentTile({
  avatar,
  className,
  size = "md",
}: {
  avatar: AgentAvatar;
  className?: string;
  size?: keyof typeof AGENT_TILE_SIZES;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 select-none items-center justify-center font-semibold text-white",
        AGENT_TILE_SIZES[size],
        AVATAR_CLASSES[avatar.color],
        className
      )}
      data-testid="agent-tile"
    >
      {avatar.glyph}
    </span>
  );
}
