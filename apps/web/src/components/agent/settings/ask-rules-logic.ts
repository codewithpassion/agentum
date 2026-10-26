// The "Ask me before it..." list on the agent's settings tab (V1.14): which
// tool keys a person can pick from, and what counts as a key to add.

import { mcpServerUrls } from "@repo/services/connectors/mcp-servers";

/** Tools every runtime has, as their rule keys. */
export const BUILTIN_TOOL_KEYS = ["bash", "write", "edit", "web_fetch"];

const WHITESPACE = /\s/;

interface SuggestionInput {
  /** The agent's connectors in assignment order, which is the order their server keys are made in. */
  connectors: readonly { name: string; tools: readonly { name: string }[] }[];
  /** Keys that already have a rule. */
  taken: readonly string[];
}

/** The tool keys to offer: the built-ins, then `<connector>/<tool>` for each connector tool. */
export const toolKeySuggestions = ({
  connectors,
  taken,
}: SuggestionInput): string[] => {
  const servers = mcpServerUrls({
    connectors: connectors.map((connector, index) => ({
      id: String(index),
      name: connector.name,
    })),
    platformUrl: "",
  }).slice(1);
  const connectorKeys = servers.flatMap(({ name }, index) =>
    (connectors[index]?.tools ?? []).map((tool) => `${name}/${tool.name}`)
  );
  return [...BUILTIN_TOOL_KEYS, ...connectorKeys].filter(
    (key) => !taken.includes(key)
  );
};

/** The key to send for what was typed, or null when it is empty or has spaces in it. */
export const toolKeyOfInput = (typed: string): string | null => {
  const key = typed.trim();
  return key === "" || WHITESPACE.test(key) ? null : key;
};
