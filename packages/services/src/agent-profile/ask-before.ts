// The actions an agent's "Ask me before it..." list offers, and the rule key
// each one has. The keys match what the run gates compute: `<serverKey>/<tool>`
// for a connector tool, with the server keys made in assignment order, and the
// bare name for a built-in tool.
import type { AskLevel } from "@repo/db/shared";
import { connectorServerKeys, PLATFORM_KEY } from "@repo/protocol/server-keys";

export interface BuiltinAction {
  /** What else the switch gates, in one plain sentence. */
  covers?: string;
  key: string;
  label: string;
}

/** Built-in tools with a side effect, by rule key, with the label a person reads. */
export const BUILTIN_ACTIONS: readonly BuiltinAction[] = [
  {
    covers: "Also the library script shell and the computer shell.",
    key: "bash",
    label: "Run a shell command",
  },
  {
    covers:
      "Also writing library files, and the library script shell, since a script there can write files.",
    key: "write",
    label: "Write a file",
  },
  {
    covers: "Also editing a file on the computer.",
    key: "edit",
    label: "Edit a file",
  },
  { key: "web_fetch", label: "Fetch a web page" },
  { key: "run_script", label: "Run a script" },
  { key: "run_skill_script", label: "Run a skill's script" },
  {
    key: `${PLATFORM_KEY}/send_message`,
    label: "Send a message to another agent",
  },
  { key: `${PLATFORM_KEY}/start_subagent`, label: "Start a subagent" },
];

/** What a person reads for a platform tool a switch covers, by rule key. */
export const PLATFORM_TOOL_LABELS: Readonly<Record<string, string>> = {
  "harbourmaster/artifact_create": "publishing a new artifact",
  "harbourmaster/artifact_promote": "making a new version of an app live",
  "harbourmaster/artifact_update": "publishing a new version of an artifact",
  "harbourmaster/bash": "the library script shell",
  "harbourmaster/computer_edit_file": "editing a file on the computer",
  "harbourmaster/computer_exec": "the computer shell",
  "harbourmaster/computer_write_file": "writing a file on the computer",
  "harbourmaster/deck_read": "reading a live deck",
  "harbourmaster/deck_write": "editing a live deck",
  "harbourmaster/document_comment": "commenting on a live document",
  "harbourmaster/document_comments": "reading live document comments",
  "harbourmaster/document_edit": "editing a live document",
  "harbourmaster/document_read": "reading a live document",
  "harbourmaster/library_write": "writing library files",
};

/** The group of the tools the platform itself provides. */
export const BUILTIN_GROUP = "Built-in tools";

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
  /** What else the switch gates, when a built-in says so. */
  covers?: string;
  /** The source the switch sits under: the connector's name, or the built-ins. */
  group: string;
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
          group: connector.name,
          key: `${serverKeys[index]}/${tool.name}`,
          kind: "connector",
          label: `${connector.name}: ${toolWords(tool.name)}`,
        })
      )
  );
  return [
    ...BUILTIN_ACTIONS.map(
      (action): GateableAction => ({
        ...action,
        group: BUILTIN_GROUP,
        kind: "builtin",
      })
    ),
    ...connectorActions,
  ];
};

const OUTSIDE_BUILTINS: ReadonlySet<string> = new Set([
  "web_fetch",
  `${PLATFORM_KEY}/send_message`,
]);

/**
 * Whether the level alone asks before the action, with no override. "Rarely"
 * asks about none of them, which is how every agent ran before levels: only the
 * checks that always run (mail outside the workspace, peers) still stop it.
 * "Outside" asks before every connector tool, fetching a web page and handing
 * work to another agent, "everything" before every action. `custom` asks about
 * nothing either: the agent's rules decide.
 */
export const levelAsks = (
  level: AskLevel,
  action: Pick<GateableAction, "key" | "kind">
): boolean => {
  switch (level) {
    case "everything":
      return true;
    case "outside":
      return action.kind === "connector" || OUTSIDE_BUILTINS.has(action.key);
    default:
      return false;
  }
};
