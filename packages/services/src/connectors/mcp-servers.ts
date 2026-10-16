export interface McpServerEntry {
  headers: Record<string, string>;
  type: "http";
  url: string;
}

export interface McpServerConnector {
  id: string;
  name: string;
}

const TRAILING_SLASHES = /\/+$/;
const NON_SLUG_RUNS = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;
const MAX_KEY_LENGTH = 40;
const FALLBACK_KEY = "connector";
const PLATFORM_KEY = "harbourmaster";

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

/**
 * The MCP servers an agent reaches, as name and URL: the platform's own
 * endpoint first, then one proxy URL per connector, in the order given.
 */
export const mcpServerUrls = (input: {
  connectors: readonly McpServerConnector[];
  platformUrl: string;
}): { name: string; url: string }[] => {
  const base = input.platformUrl.replace(TRAILING_SLASHES, "");
  const servers = [{ name: PLATFORM_KEY, url: `${base}/mcp` }];
  const taken = new Set<string>([PLATFORM_KEY]);
  for (const connector of input.connectors) {
    const name = freeKey(slugify(connector.name), taken);
    taken.add(name);
    servers.push({ name, url: `${base}/api/proxy/${connector.id}` });
  }
  return servers;
};

/**
 * The `mcpServers` map a run gets at claim time. The platform's own MCP
 * endpoint comes first, then one proxy entry per connector, in the order given.
 */
export const buildMcpServers = (input: {
  connectors: readonly McpServerConnector[];
  platformUrl: string;
  runToken: string;
}): Record<string, McpServerEntry> =>
  Object.fromEntries(
    mcpServerUrls(input).map(({ name, url }): [string, McpServerEntry] => [
      name,
      {
        headers: { Authorization: `Bearer ${input.runToken}` },
        type: "http",
        url,
      },
    ])
  );
