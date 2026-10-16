// A run's files, between the Worker and the work directory. Before the first
// message the input files are downloaded into `inbox/`; after a successful
// run the `[ATTACHMENT:path]` markers in the answer are uploaded and replaced
// by file ids. The work directory access goes through `WorkFiles`, which uses
// plain `node:fs` on a single-user machine and sudo on a multi-user one.

import {
  extractAttachmentMarkers,
  MAX_OUTBOUND_BYTES,
  rejectionNote,
} from "./attachments.ts";
import type { FilesApi } from "./files-api.ts";
import type { WorkFiles } from "./work-files.ts";
import { INBOX_DIR } from "./workdir.ts";

/** A file the run did not get, in the words the answer carries. */
const uploadFailedNote = (name: string): string =>
  `[attachment failed: ${name}]`;

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

export interface UploadOutputOptions {
  api: FilesApi;
  files: WorkFiles;
  log: (message: string) => void;
  signal: AbortSignal;
  text: string;
}

export interface UploadedOutputs {
  fileIds: string[];
  /** The answer without its markers, plus a note for each file that did not go. */
  text: string;
}

/**
 * Uploads the files that the answer's `[ATTACHMENT:path]` markers name and
 * returns the ids. A marker that is refused (outside the work directory,
 * missing, over 50 MB) or whose read or upload fails leaves a note in the text
 * and no id; the run itself still counts as done. Aborting stops the uploads
 * and rejects.
 */
export const uploadOutputs = async (
  options: UploadOutputOptions
): Promise<UploadedOutputs> => {
  const { api, files, log, signal, text } = options;
  const extracted = extractAttachmentMarkers(text);
  if (extracted.paths.length === 0) {
    return { fileIds: [], text };
  }
  const { files: outgoing, rejected } = await files.resolveOutbound(
    extracted.paths,
    MAX_OUTBOUND_BYTES
  );
  for (const refused of rejected) {
    log(`attachment ${refused.path} refused: ${refused.reason}`);
  }
  const notes = rejected.map(rejectionNote);
  const uploadOne = async (file: (typeof outgoing)[number]) =>
    api.upload({ body: await files.read(file), name: file.name }, signal);
  const fileIds: string[] = [];
  for (const file of outgoing) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: uploads go one at a time, so a slow link is not asked for 50 MB several times at once.
      const uploaded = await uploadOne(file);
      fileIds.push(uploaded.id);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      log(`attachment ${file.path} not uploaded: ${detail}`);
      notes.push(uploadFailedNote(file.name));
    }
  }
  return { fileIds, text: [extracted.text, ...notes].join("\n").trim() };
};
