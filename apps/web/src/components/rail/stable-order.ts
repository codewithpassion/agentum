/**
 * Keeps the open row at its on-screen index while the list reorders around it.
 * `nextItems` is the desired order. `previousIds` is the order on screen.
 */
export function stableOrder<T extends { id: string }>(
  previousIds: readonly string[],
  nextItems: readonly T[],
  openId: string | null
): T[] {
  if (openId === null) {
    return [...nextItems];
  }
  const open = nextItems.find((item) => item.id === openId);
  const previousIndex = previousIds.indexOf(openId);
  if (!open || previousIndex === -1) {
    return [...nextItems];
  }
  const rest = nextItems.filter((item) => item.id !== open.id);
  const at = Math.min(previousIndex, rest.length);
  return [...rest.slice(0, at), open, ...rest.slice(at)];
}

/** Ids that were not on screen before. Nothing is fresh on first load. */
export function freshIds(
  previousIds: readonly string[],
  items: readonly { id: string }[]
): Set<string> {
  if (previousIds.length === 0) {
    return new Set();
  }
  const known = new Set(previousIds);
  return new Set(items.map((item) => item.id).filter((id) => !known.has(id)));
}
