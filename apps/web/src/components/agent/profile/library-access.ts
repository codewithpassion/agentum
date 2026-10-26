import type { AgentProfileView } from "#/integrations/trpc/types";

type Folder = AgentProfileView["library"]["folders"][number];
export type AccessMode = Folder["access"];

const WIKI_PATH = "wiki";

/**
 * The profile lists the home folder, then the wiki, then the grants. Home and
 * the wiki are fixed; only the grants can change.
 */
export const splitFolders = (
  folders: readonly Folder[]
): { grants: Folder[]; home: Folder | undefined; wiki: Folder | undefined } => {
  const home = folders.find((folder) => folder.home);
  const rest = folders.filter((folder) => !folder.home);
  const wiki = rest[0]?.path === WIKI_PATH ? rest[0] : undefined;
  return { grants: wiki ? rest.slice(1) : rest, home, wiki };
};

export const otherMode = (mode: AccessMode): AccessMode =>
  mode === "read" ? "write" : "read";

export const modeLabel = (mode: AccessMode): string =>
  mode === "read" ? "Read only" : "Read and write";

/** The folders of a library listing, for the picker. */
export const folderPaths = (
  entries: readonly { kind: string; path: string }[]
): string[] =>
  entries.filter((entry) => entry.kind === "dir").map((entry) => entry.path);
