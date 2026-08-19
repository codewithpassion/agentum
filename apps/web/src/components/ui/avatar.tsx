import { initialsFor } from "#/lib/format";

const SIZES = {
  lg: "h-12 w-12 text-base",
  md: "h-8 w-8 text-xs",
  sm: "h-6 w-6 text-[10px]",
} as const;

/**
 * Agent identity is the one place colour appears: the background is the agent's
 * deterministic avatar seed (see `avatarForName` in the agents module).
 */
export function Avatar({
  color,
  name,
  size = "md",
}: {
  color: string;
  name: string;
  size?: keyof typeof SIZES;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${SIZES[size]}`}
      style={{ background: color }}
    >
      {initialsFor(name)}
    </span>
  );
}
