/**
 * The Hands to list to save after a toggle. Ids that are not in `activeIds`
 * (an archived target, say) drop out, because the service rejects them.
 */
export const nextHandsTo = (
  current: readonly string[],
  activeIds: ReadonlySet<string>,
  targetId: string,
  checked: boolean
): string[] => {
  const kept = current.filter((id) => activeIds.has(id) && id !== targetId);
  return checked ? [...kept, targetId] : kept;
};
