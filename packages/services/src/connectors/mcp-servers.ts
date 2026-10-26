import { connectorServerKeys, PLATFORM_KEY } from "@repo/protocol/server-keys";

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

/**
 * The MCP servers an agent reaches, as name and URL: the platform's own
 * endpoint first, then one proxy URL per connector, in the order given.
 */
export const mcpServerUrls = (input: {
  connectors: readonly McpServerConnector[];
  platformUrl: string;
}): { name: string; url: string }[] => {
  const base = input.platformUrl.replace(TRAILING_SLASHES, "");
  const keys = connectorServerKeys(input.connectors.map(({ name }) => name));
  return [
    { name: PLATFORM_KEY, url: `${base}/mcp` },
    ...input.connectors.map((connector, index) => ({
      name: keys[index] ?? connector.id,
      url: `${base}/api/proxy/${connector.id}`,
    })),
  ];
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
