/** The parts of a thread a person changes from its header. */
export interface ThreadMeta {
  archivedAt: string | null;
  pinnedAt: string | null;
  title: string;
}

/** The name a person typed, or null when it is empty or the same as now. */
export const newTitle = (typed: string, current: string): string | null => {
  const name = typed.trim();
  return name === "" || name === current ? null : name;
};
