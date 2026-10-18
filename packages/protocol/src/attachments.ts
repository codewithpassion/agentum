// The `[ATTACHMENT:path]` marker convention, shared by the daemon and the web chat.
//
// An agent hands a file back to the chat by writing `[ATTACHMENT:path]` in its
// reply. Skills rely on this exact syntax, so the pattern below is the contract.
//
// The workspace instructions builder lives here too, since it ends with the same marker line.

export const ATTACHMENT_MARKER_RE = /\[ATTACHMENT:([^\]]+)\]/g;
/** Write a marker for `path`, the inverse of what `ATTACHMENT_MARKER_RE` reads. */
export const formatAttachmentMarker = (path: string): string =>
  `[ATTACHMENT:${path}]`;

/**
 * The sentences that tell an agent how to return a file. Built from
 * `formatAttachmentMarker` so the wording and the parser cannot drift.
 */
export const attachmentInstructions = (workDir: string): string =>
  `To give the user a file, write it inside your work directory (${workDir}) and put ${formatAttachmentMarker("<absolute path>")} on its own line in your final answer.`;

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
  /**
   * Where the agent keeps its own files across sessions. A folder path when
   * `homeIsLocal`, otherwise a library-relative path such as `agents/<slug>/`.
   */
  home: string;
  /** True when home is a folder on the agent's own disk, false when it is a library folder. */
  homeIsLocal: boolean;
  /** The library folder on the agent's disk, or null when it is reached with the library tools only. */
  library: string | null;
  /** The temporary area. `path` is null when the runtime has no scratch folder. */
  scratch: { path: string | null; lasts: ScratchLifetime };
}

const SCRATCH_ENDS: Record<ScratchLifetime, string> = {
  call: "kept for one tool call only",
  "run-start": "emptied before your next run",
  session: "deleted when this session ends",
  "vm-sleep": "deleted when the VM sleeps after a few idle minutes",
};

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

const libraryLine = ({ library }: WorkspaceInstructionsInput): string =>
  library
    ? `- Library: ${library}. It is shared with every agent and person in this workspace and kept for good. Put finished work that people or other agents should see there.`
    : "- Library: the workspace library. It is shared with every agent and person in this workspace and kept for good. It is not a folder on your disk, so reach it with the library tools. Put finished work that people or other agents should see there.";

/**
 * The files section of an agent's system prompt: the same three areas (home,
 * scratch, library) and the attachment line, worded for what each runtime has.
 * A library that is not local is never given a path, so an agent cannot
 * mistake it for a working directory.
 */
export const workspaceInstructions = (
  input: WorkspaceInstructionsInput
): string =>
  [
    "Your files live in three places.",
    homeLine(input),
    scratchLine(input),
    libraryLine(input),
    ...(input.attachments === false
      ? []
      : [
          `To give the user a file, put ${formatAttachmentMarker("<absolute path>")} on its own line in your final answer.`,
        ]),
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
