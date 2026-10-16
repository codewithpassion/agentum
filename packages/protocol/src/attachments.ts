// The `[ATTACHMENT:path]` marker convention, shared by the daemon and the web chat.
//
// An agent hands a file back to the chat by writing `[ATTACHMENT:path]` in its
// reply. Skills rely on this exact syntax, so the pattern below is the contract.

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
