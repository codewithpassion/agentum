// The pure helpers behind the typed tool cards of the task thread: what a
// call's card shows, and the label of a group of calls.

export type ToolKind = "command" | "file" | "generic" | "skill" | "web";

export interface ToolCardInfo {
  /** The full input as text, for the details view. */
  input: string | null;
  kind: ToolKind;
  /** The result as text, truncated. */
  output: string | null;
  state: "done" | "failed" | "running";
  /** The one line that says what the call did, truncated. */
  subtitle: string | null;
  /** The tool name, or "Tool" when the name is null. */
  title: string;
}

export interface ToolCall {
  input: unknown;
  name: string | null;
  ok: boolean | null;
  result: unknown;
}

const OUTPUT_LIMIT = 4000;
const OUTPUT_CUT = "\n… (truncated)";
const SUBTITLE_LIMIT = 120;
const ELLIPSIS = "…";

const KIND_BY_NAME: ReadonlyMap<string, ToolKind> = new Map<string, ToolKind>([
  ["activate_skill", "skill"],
  ["bash", "command"],
  ["edit", "file"],
  ["edit_file", "file"],
  ["exec", "command"],
  ["execute_command", "command"],
  ["fetch", "web"],
  ["multiedit", "file"],
  ["read", "file"],
  ["read_file", "file"],
  ["run_command", "command"],
  ["sh", "command"],
  ["shell", "command"],
  ["skill", "skill"],
  ["str_replace_editor", "file"],
  ["view", "file"],
  ["web_fetch", "web"],
  ["web_search", "web"],
  ["webfetch", "web"],
  ["websearch", "web"],
  ["write", "file"],
  ["write_file", "file"],
]);

const SUBTITLE_FIELDS: Record<ToolKind, readonly string[]> = {
  command: ["command", "cmd"],
  file: ["file_path", "path", "filename"],
  generic: [],
  skill: ["skill", "name"],
  web: ["url", "query"],
};

const kindOf = (name: string | null): ToolKind => {
  if (name === null) {
    return "generic";
  }
  return KIND_BY_NAME.get(name.toLowerCase()) ?? "generic";
};

/** The first `limit` characters of `text`, counting code points, cut with `suffix`. */
const cut = (text: string, limit: number, suffix: string): string => {
  const chars = Array.from(text);
  if (chars.length <= limit) {
    return text;
  }
  return chars.slice(0, limit).join("") + suffix;
};

/** The subtitle cut to 120 characters in all, ending in an ellipsis when cut. */
const subtitleCut = (text: string): string => {
  const chars = Array.from(text);
  if (chars.length <= SUBTITLE_LIMIT) {
    return text;
  }
  return chars.slice(0, SUBTITLE_LIMIT - 1).join("") + ELLIPSIS;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const subtitleOf = (kind: ToolKind, input: unknown): string | null => {
  if (!isPlainObject(input)) {
    return null;
  }
  for (const field of SUBTITLE_FIELDS[kind]) {
    const value = input[field];
    if (typeof value === "string" && value !== "") {
      return subtitleCut(value);
    }
  }
  return null;
};

const stateOf = (ok: boolean | null): ToolCardInfo["state"] => {
  if (ok === null) {
    return "running";
  }
  return ok ? "done" : "failed";
};

/** A value as text: strings as they are, anything else as JSON, or null when empty. */
export const asText = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    text = encode(value);
  }
  return text === "" ? null : text;
};

const encode = (value: unknown): string => {
  try {
    const json: string | undefined = JSON.stringify(value, null, 2);
    if (json !== undefined) {
      return json;
    }
  } catch {
    // A value JSON cannot encode, such as a BigInt, falls through to String.
  }
  return String(value);
};

const boundedText = (value: unknown, limit: number): string | null => {
  const text = asText(value);
  return text === null ? null : cut(text, limit, OUTPUT_CUT);
};

/** What a tool call's card shows. */
export const toolCardInfo = (call: ToolCall): ToolCardInfo => {
  const kind = kindOf(call.name);
  return {
    input: boundedText(call.input, OUTPUT_LIMIT),
    kind,
    output: boundedText(call.result, OUTPUT_LIMIT),
    state: stateOf(call.ok),
    subtitle: subtitleOf(kind, call.input),
    title: call.name ?? "Tool",
  };
};

/** The label of a group of tool calls: runs of the same name count as "name ×n", so "Read ×3, Bash". */
export const groupLabel = (names: readonly (string | null)[]): string => {
  if (names.length === 0) {
    return "No tool calls";
  }
  const runs: { count: number; name: string }[] = [];
  for (const raw of names) {
    const name = raw ?? "Tool";
    const last = runs.at(-1);
    if (last?.name === name) {
      last.count += 1;
    } else {
      runs.push({ count: 1, name });
    }
  }
  return runs
    .map(({ count, name }) => (count === 1 ? name : `${name} ×${count}`))
    .join(", ");
};
