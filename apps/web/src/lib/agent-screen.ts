import type { ActivityView } from "./api";

/**
 * The pure parts of the right rail's agent screen: path arithmetic for the file
 * browser, page merging for the activity feed, and the narrowing that turns an
 * activity row's free-form `detail` JSON into something typed enough to render.
 * Everything here is unit-tested; the components around it only do I/O.
 */

export const ROOT_PATH = "/";

const TRAILING_SLASH = /\/+$/;

export const parentPath = (path: string): string => {
  const trimmed = path.replace(TRAILING_SLASH, "");
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash <= 0 ? ROOT_PATH : trimmed.slice(0, lastSlash);
};

/** Never produces a double slash, so `/` + `notes.txt` is `/notes.txt`. */
export const joinPath = (directory: string, name: string): string =>
  `${directory.replace(TRAILING_SLASH, "")}/${name}`;

export interface Crumb {
  label: string;
  path: string;
}

/** `/a/b` → root, `a`, `b`; the last crumb is the directory that is open. */
export const breadcrumbsFor = (path: string): Crumb[] => {
  const crumbs: Crumb[] = [{ label: ROOT_PATH, path: ROOT_PATH }];
  let current = "";
  for (const segment of path.split("/").filter(Boolean)) {
    current = `${current}/${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
};

/**
 * A poll returns the newest page again, and "Load more" returns an older one -
 * both go through here, so an entry seen twice stays one row and the feed stays
 * newest-first however the two arrive.
 */
export const mergeActivity = (
  existing: ActivityView[],
  incoming: ActivityView[]
): ActivityView[] => {
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    byId.set(entry.id, entry);
  }
  return [...byId.values()].sort(
    (left, right) =>
      right.createdAt - left.createdAt || right.id.localeCompare(left.id)
  );
};

/**
 * The computer reads files as UTF-8, so a binary file comes back as replacement
 * characters rather than as an error. Anything that decoded lossily is offered
 * as a download instead of being rendered as text.
 */
const REPLACEMENT_CHARACTER = "�";

export const looksBinary = (content: string): boolean =>
  content.includes(REPLACEMENT_CHARACTER) || content.includes("\0");

const readString = (
  detail: Record<string, unknown>,
  key: string
): string | null => {
  const value = detail[key];
  return typeof value === "string" ? value : null;
};

export interface ExecView {
  command: string;
  /** Set when the command never ran; `exitCode` is null in that case. */
  error: string | null;
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

/** `computer.exec` rows carry either an outcome or a failure reason, never both. */
export const toExecView = (entry: ActivityView): ExecView | null => {
  if (entry.kind !== "computer.exec" || !entry.detail) {
    return null;
  }
  const command = readString(entry.detail, "command");
  if (command === null) {
    return null;
  }
  const { exitCode } = entry.detail;
  return {
    command,
    error: readString(entry.detail, "error"),
    exitCode: typeof exitCode === "number" ? exitCode : null,
    stderr: readString(entry.detail, "stderr") ?? "",
    stdout: readString(entry.detail, "stdout") ?? "",
  };
};

/** The newest command in a newest-first page, which is what the Screen tab shows. */
export const latestExec = (entries: ActivityView[]): ExecView | null => {
  for (const entry of entries) {
    const exec = toExecView(entry);
    if (exec) {
      return exec;
    }
  }
  return null;
};
