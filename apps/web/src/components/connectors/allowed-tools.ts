export interface ToolEntry {
  description: string | null;
  name: string;
}

/** The row text for an assignment's tool access. Null means every tool. */
export const toolAccessLabel = (
  allowedTools: readonly string[] | null,
  tools: readonly ToolEntry[]
): string => {
  if (allowedTools === null) {
    return "All tools";
  }
  if (tools.length === 0) {
    return `${allowedTools.length} tools allowed`;
  }
  const cached = new Set(tools.map((tool) => tool.name));
  const allowed = allowedTools.filter((name) => cached.has(name)).length;
  return `${allowed} of ${tools.length} tools allowed`;
};

/** Allowlisted names that the cached tool list does not contain. */
export const extraToolNames = (
  allowedTools: readonly string[] | null,
  tools: readonly ToolEntry[]
): string[] => {
  if (allowedTools === null) {
    return [];
  }
  const cached = new Set(tools.map((tool) => tool.name));
  return allowedTools.filter((name) => !cached.has(name));
};

/** Case-insensitive match on a tool's name or description. */
export const matchesToolFilter = (tool: ToolEntry, filter: string): boolean => {
  const needle = filter.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  return (
    tool.name.toLowerCase().includes(needle) ||
    (tool.description ?? "").toLowerCase().includes(needle)
  );
};
