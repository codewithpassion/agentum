// Shared workspace instructions and legacy `[ATTACHMENT:path]` parsing.
// Runtimes move to task folders independently; old transcripts still use markers.

import type { LibraryAccessGrant } from "@repo/db/shared";

export const ATTACHMENT_MARKER_RE = /\[ATTACHMENT:([^\]]+)\]/g;

/** When the files in a runtime's scratch area disappear. */
export type ScratchLifetime =
  /** The VM sleeps after a few idle minutes. */
  | "vm-sleep"
  /** The runtime empties the folder before the next run. */
  | "run-start"
  /** The runtime's own disk goes when the session ends or rotates. */
  | "session"
  /** The runtime keeps nothing between tool calls. */
  | "call";

export interface WorkspaceInstructionsInput {
  /** False when the runtime never reads `[ATTACHMENT:...]` markers, so the line is left out. Default true. */
  attachments?: boolean;
  /** Library paths of conflict copies still waiting from earlier runs. Empty or absent adds no line. */
  conflicts?: readonly string[];
  /**
   * Where the agent keeps its own files across sessions. A folder path when
   * `homeIsLocal`, otherwise a library-relative path such as `agents/<slug>/`.
   */
  home: string;
  /** True when home is a folder on the agent's own disk, false when it is a library folder. */
  homeIsLocal: boolean;
  /** The library folder on the agent's disk, or null when it is reached with the library tools only. */
  library: string | null;
  /** True when changes to the local library copy sync within seconds. Default false. */
  liveSync?: boolean;
  /** Access modes for library roots; nonempty roots take precedence over syncedPaths. */
  roots?: readonly LibraryAccessGrant[];
  /** True when the agent has the `run_script` tool, which only isolate agents have. Default false. */
  runScript?: boolean;
  /** The temporary area. `path` is null when the runtime has no scratch folder. */
  scratch: { path: string | null; lasts: ScratchLifetime };
  /** Library paths copied to the `library` folder. Only read when `library` is a path. */
  syncedPaths?: readonly string[];
  /** Where to save user files: a local folder, or a library path without a local copy. */
  taskFolder?: string;
}

const SCRATCH_ENDS: Record<ScratchLifetime, string> = {
  call: "kept for one tool call only",
  "run-start": "emptied before your next run",
  session: "deleted when this session ends",
  "vm-sleep": "deleted when the VM sleeps after a few idle minutes",
};

const RUN_SCRIPT_PARAGRAPH =
  "You have no shell runtime such as node, bun or python. To run JavaScript or TypeScript, use `run_script` with a library file or inline code. Scripts can read and write the library and, when network access is on, use fetch. npm packages and Node built-ins such as fs and child_process aren't available. For work that needs them, ask for this agent to use the Linux VM.";

const homeLine = ({ home, homeIsLocal }: WorkspaceInstructionsInput): string =>
  homeIsLocal
    ? `- Home: ${home}. It is yours and keeps its files across all your sessions. Relative paths start here. Keep notes, code and data you want to find again here. Other sessions of yours may use it at the same time.`
    : `- Home: the library folder ${home}. It is yours and keeps its files across all your sessions. It is not a folder on your disk, so reach it with the library tools. Keep notes and data you want to find again here.`;

const scratchLine = ({
  library,
  scratch,
}: WorkspaceInstructionsInput): string => {
  const ends = SCRATCH_ENDS[scratch.lasts];
  const kept = library ? "home and the library" : "home";
  const where = scratch.path
    ? `${scratch.path}. Use it for downloads, builds and temporary files. It is ${ends}`
    : `no scratch folder. Files you write outside ${kept} are ${ends}`;
  return `- Scratch: ${where}, so never keep anything there that you need later.`;
};

const libraryLine = ({
  library,
  liveSync,
  roots,
  syncedPaths,
}: WorkspaceInstructionsInput): string => {
  // Mode-bearing roots win when supplied; an empty list keeps legacy callers' wording.
  const rootList = roots?.length
    ? roots.map(({ path, mode }) => `${path} (${mode})`).join(", ")
    : undefined;
  const paths = rootList ?? syncedPaths?.join(", ");
  if (library && paths) {
    const when = liveSync ? "within seconds" : "when your run ends";
    return `- Library: ${library} holds a synced copy of ${paths} from the workspace library. The library is shared with every agent and person in this workspace and kept for good. Your changes go back to it ${when}. If someone changed the same file meanwhile, their version stays and yours is saved next to it as <file>.conflict-<runId>. The rest of the library is not on your disk, so reach it with the library tools.`;
  }
  const access = rootList ? ` Your access to library roots: ${rootList}.` : "";
  return library
    ? `- Library: ${library}. It is shared with every agent and person in this workspace and kept for good. Put finished work that people or other agents should see there.${access}`
    : `- Library: the workspace library. It is shared with every agent and person in this workspace and kept for good. It is not a folder on your disk, so reach it with the library tools. Put finished work that people or other agents should see there.${access}`;
};

const userFilesLines = ({
  attachments,
  taskFolder,
}: WorkspaceInstructionsInput): string[] => {
  // attachments only controls legacy markers; task folders work without marker parsing.
  if (taskFolder !== undefined) {
    return [
      `Save files for the user in ${taskFolder}. Everything there shows in the task's Files panel.`,
    ];
  }
  return attachments === false
    ? []
    : [
        "To give the user a file, put [ATTACHMENT:<absolute path>] on its own line in your final answer.",
      ];
};

const conflictsLines = ({
  library,
  conflicts,
}: WorkspaceInstructionsInput): string[] => {
  if (!conflicts || conflicts.length === 0) {
    return [];
  }
  const list = conflicts
    .map((path) => (library ? `${library}/${path}` : path))
    .join(", ");
  return [
    `- Conflicts: some changes could not be saved because the library file changed first. Each copy listed here holds the version that was not saved. Compare it with the file beside it, keep what you want in that file, then delete the copy: ${list}.`,
  ];
};

/**
 * The files section of an agent's system prompt: the same three areas (home,
 * scratch, library) and user file guidance, worded for what each runtime has.
 * A library that is not local is explicitly reached with library tools, so
 * its paths cannot be mistaken for local working directories.
 */
export const workspaceInstructions = (
  input: WorkspaceInstructionsInput
): string =>
  [
    "Your files live in three places.",
    homeLine(input),
    scratchLine(input),
    libraryLine(input),
    ...conflictsLines(input),
    ...userFilesLines(input),
    ...(input.runScript ? ["", RUN_SCRIPT_PARAGRAPH] : []),
  ].join("\n");

const MARKER_WITH_LEADING_SPACE_RE = new RegExp(
  ` ?${ATTACHMENT_MARKER_RE.source}`,
  "g"
);
const TRAILING_SPACE_RE = /[ \t]+\n/g;
const BLANK_RUN_RE = /\n\s*\n\s*\n/g;

/**
 * Remove every marker from `text` and tidy what they leave behind. A marker
 * takes one preceding space, so "a [ATTACHMENT:x] b" becomes "a b". Trailing
 * spaces before newlines and blank-line runs are collapsed, then the result is
 * trimmed. Text without a marker comes back unchanged.
 */
export const stripAttachmentMarkers = (text: string): string => {
  if (!text.includes("[ATTACHMENT:")) {
    return text;
  }
  return text
    .replace(MARKER_WITH_LEADING_SPACE_RE, "")
    .replace(TRAILING_SPACE_RE, "\n")
    .replace(BLANK_RUN_RE, "\n\n")
    .trim();
};

export interface ExtractedMarkers {
  /** Marker paths in order of first appearance, trimmed and de-duplicated. */
  paths: string[];
  /** `text` with every marker removed and leftover blank runs collapsed. */
  text: string;
}

/**
 * Pull `[ATTACHMENT:...]` markers out of `text`. Paths may contain spaces:
 * anything up to the closing `]` is the path.
 */
export const extractAttachmentMarkers = (text: string): ExtractedMarkers => {
  if (!text.includes("[ATTACHMENT:")) {
    return { paths: [], text };
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(ATTACHMENT_MARKER_RE)) {
    const path = (match[1] ?? "").trim();
    if (path.length === 0 || seen.has(path)) {
      continue;
    }
    seen.add(path);
    paths.push(path);
  }
  return { paths, text: stripAttachmentMarkers(text) };
};
