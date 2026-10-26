// The actions an agent's "Ask me before it..." list offers, and the rule key
// each one has. The keys match what the run gates compute: `<serverKey>/<tool>`
// for a connector tool, with the server keys made in assignment order, and the
// bare name for a built-in tool.
import { connectorServerKeys } from "@repo/protocol/server-keys";

/** Built-in tools with a side effect, by rule key, with the label a person reads. */
export const BUILTIN_ACTIONS = [
  { key: "bash", label: "Run a shell command" },
  { key: "write", label: "Write a file" },
  { key: "edit", label: "Edit a file" },
  { key: "web_fetch", label: "Fetch a web page" },
  { key: "run_script", label: "Run a script" },
  { key: "run_skill_script", label: "Run a skill's script" },
] as const;

const WORD_SEPARATORS = /[_-]+/g;

/** A tool name as words: `create_bill` is "create bill". */
const toolWords = (name: string): string =>
  name.replace(WORD_SEPARATORS, " ").trim();

export interface ActionConnector {
  /** Tool names the agent may use through it, null for every tool. */
  allowedTools: readonly string[] | null;
  name: string;
  tools: readonly { name: string; readOnly: boolean }[];
}

export interface GateableAction {
  key: string;
  kind: "builtin" | "connector";
  /** "Xero: create bill". */
  label: string;
}

/**
 * The built-ins, then the connector tools that are not read-only and the agent
 * may use. `connectors` are the agent's, in assignment order.
 */
export const gateableActions = (
  connectors: readonly ActionConnector[]
): GateableAction[] => {
  const serverKeys = connectorServerKeys(connectors.map(({ name }) => name));
  const connectorActions = connectors.flatMap((connector, index) =>
    connector.tools
      .filter(
        (tool) =>
          !tool.readOnly &&
          (connector.allowedTools === null ||
            connector.allowedTools.includes(tool.name))
      )
      .map(
        (tool): GateableAction => ({
          key: `${serverKeys[index]}/${tool.name}`,
          kind: "connector",
          label: `${connector.name}: ${toolWords(tool.name)}`,
        })
      )
  );
  return [
    ...BUILTIN_ACTIONS.map(
      ({ key, label }): GateableAction => ({ key, kind: "builtin", label })
    ),
    ...connectorActions,
  ];
};
