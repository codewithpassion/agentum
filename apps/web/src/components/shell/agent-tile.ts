const TILE_COLOURS = [
  "bg-sky-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-violet-600",
  "bg-teal-600",
] as const;

const WHITESPACE = /\s+/;

/** Up to two initials: first letters of the first two words. */
export function agentInitials(name: string): string {
  const words = name.trim().split(WHITESPACE).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word.charAt(0));
  return (letters.join("") || "?").toUpperCase();
}

/** A stable tile colour per name. */
export function agentTileColour(name: string): string {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return TILE_COLOURS[hash % TILE_COLOURS.length] ?? TILE_COLOURS[0];
}
