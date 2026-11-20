// Where an agent's memory files sit in the library, `agents/<slug>/memory/`.
// Only the memory service writes there (`docs/v4/memory-format.md`), and a
// private file is for one person and the agent's runs for that person.
const MEMORY_FOLDER = /^agents\/[^/]+\/memory(?:\/(.*))?$/;
const PRIVATE_PREFIX = "private/";
const MARKDOWN = ".md";

/** The folder `agents/<slug>/memory`, or any path under it. Paths are normalised, with no slash at either end. */
export const isMemoryPath = (path: string): boolean => MEMORY_FOLDER.test(path);

/** The path of an agent's memory folder, without a trailing slash. */
export const memoryFolderOf = (slug: string): string => `agents/${slug}/memory`;

/**
 * The person a path under `agents/<slug>/memory/private/` belongs to, which is
 * the file name without `.md`. Anything else under that folder, such as a stray
 * file or a subfolder, returns the empty string, which matches no person. A path
 * that is not under a private folder returns null, and so does the private
 * folder itself, so it can still be listed and walked.
 */
export const privateMemoryOwner = (path: string): string | null => {
  const rest = MEMORY_FOLDER.exec(path)?.[1];
  if (!rest?.startsWith(PRIVATE_PREFIX)) {
    return null;
  }
  const name = rest.slice(PRIVATE_PREFIX.length);
  return name.endsWith(MARKDOWN) && !name.includes("/") && name.length > 3
    ? name.slice(0, -MARKDOWN.length)
    : "";
};

/** Whether `userId` may read `path`: true unless it is another person's private memory file. */
export const mayReadMemoryPath = (
  path: string,
  userId: string | null
): boolean => {
  const owner = privateMemoryOwner(path);
  return owner === null || (owner !== "" && owner === userId);
};
