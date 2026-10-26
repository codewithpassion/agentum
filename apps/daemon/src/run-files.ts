// A run's input files, between the Worker and the work directory. Before the
// first message the input files are downloaded into `inbox/`. The work
// directory access goes through `WorkFiles`, which uses plain `node:fs` on a
// single-user machine and sudo on a multi-user one. Files the agent saves in
// its task folder reach the library by sync, so nothing is uploaded back here.

import type { FilesApi } from "./files-api.ts";
import type { WorkFiles } from "./work-files.ts";
import { INBOX_DIR } from "./workdir.ts";

export interface FetchInputOptions {
  api: FilesApi;
  fileIds: string[];
  files: WorkFiles;
  signal: AbortSignal;
}

/** Name for `name` that no earlier file in `taken` has, by prefixing the file id. */
const uniqueName = (
  name: string,
  fileId: string,
  taken: Set<string>
): string => (taken.has(name) ? `${fileId}-${name}` : name);

/**
 * Downloads every input file into `<workDir>/inbox/` and returns their paths
 * relative to the work directory, in the order of `fileIds`. The first file
 * that cannot be fetched ends the call with an error naming its id.
 */
export const fetchInputFiles = async (
  options: FetchInputOptions
): Promise<string[]> => {
  const { api, fileIds, files, signal } = options;
  if (fileIds.length === 0) {
    return [];
  }
  const fetched = await Promise.all(
    fileIds.map(async (fileId) => {
      try {
        const { body, name } = await api.download(fileId, signal);
        return {
          bytes: new Uint8Array(await body.arrayBuffer()),
          fileId,
          name,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Input file ${fileId} could not be fetched: ${detail}`,
          {
            cause: error,
          }
        );
      }
    })
  );
  const taken = new Set<string>();
  const paths: string[] = [];
  for (const file of fetched) {
    const name = uniqueName(file.name, file.fileId, taken);
    taken.add(name);
    // biome-ignore lint/performance/noAwaitInLoops: files are written one at a time, in the order of the ids.
    await files.write(`${INBOX_DIR}/${name}`, file.bytes);
    paths.push(`${INBOX_DIR}/${name}`);
  }
  return paths;
};

/** The first message: the task text, then where the input files are. */
export const messageWithFiles = (text: string, paths: string[]): string =>
  paths.length === 0
    ? text
    : `${text}\n\nFiles attached to this message, saved in your working directory:\n${paths
        .map((path) => `- ${path}`)
        .join("\n")}`;
