// The MCP server key each connector gets in an agent's run, and so the prefix
// of its tool keys (`<key>/<tool>`). Browser safe: the web app reads it to
// suggest rule keys, the Worker to build the run's server map.

const NON_SLUG_RUNS = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;
const MAX_KEY_LENGTH = 40;
const FALLBACK_KEY = "connector";

/** The key of the platform's own MCP endpoint, which no connector may take. */
export const PLATFORM_KEY = "harbourmaster";

const slugify = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(NON_SLUG_RUNS, "-")
    .slice(0, MAX_KEY_LENGTH)
    .replace(EDGE_DASHES, "");
  return slug || FALLBACK_KEY;
};

const freeKey = (base: string, taken: Set<string>): string => {
  let key = base;
  for (let suffix = 2; taken.has(key); suffix += 1) {
    key = `${base}-${suffix}`;
  }
  return key;
};

/** One server key per connector name, in the order given. */
export const connectorServerKeys = (names: readonly string[]): string[] => {
  const taken = new Set<string>([PLATFORM_KEY]);
  return names.map((name) => {
    const key = freeKey(slugify(name), taken);
    taken.add(key);
    return key;
  });
};
