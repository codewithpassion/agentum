/**
 * The `allowed_tools` column on an assignment: a JSON array of tool names, or
 * null for "every tool". An empty list is stored as null, so "empty" and "not
 * set" mean the same thing everywhere.
 */

/** The names to store, deduplicated; null when there are none. */
export const encodeAllowedTools = (
  tools: readonly string[] | null | undefined
): string | null => {
  const unique = [...new Set(tools ?? [])];
  return unique.length === 0 ? null : JSON.stringify(unique);
};

/** The names from a stored value; null when every tool is allowed. */
export const decodeAllowedTools = (raw: string | null): string[] | null => {
  if (raw === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    !(
      Array.isArray(parsed) &&
      parsed.every((item): item is string => typeof item === "string")
    )
  ) {
    throw new Error("agent_connectors.allowed_tools is not a list of names");
  }
  return parsed.length === 0 ? null : parsed;
};
