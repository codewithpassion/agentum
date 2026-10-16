// A run's files, between the Worker and the work directory. Before the first
// message the input files are downloaded into `inbox/`; after a successful
// run the `[ATTACHMENT:path]` markers in the answer are uploaded and replaced
// by file ids.
//
// Only a single-user machine can do this. In multi-user mode the work directory
// belongs to hm-agent and the daemon's user cannot read or write it, so the
// executor refuses input files up front and `uploadOutputs` refuses every
// marker, instead of failing deep inside the run with a permission error.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { file as bunFile } from "bun";
import {
  extractAttachmentMarkers,
  MAX_OUTBOUND_BYTES,
  type RejectedFile,
  rejectionNote,
  resolveOutboundFiles,
} from "./attachments.ts";
import type { FilesApi } from "./files-api.ts";
import { INBOX_DIR } from "./workdir.ts";

export const MULTI_USER_FILES_MESSAGE =
  "File transfer is not supported on a multi-user machine yet (the work directory belongs to hm-agent)";

/** A file the run did not get, in the words the answer carries. */
const uploadFailedNote = (name: string): string =>
  `[attachment failed: ${name}]`;

export interface FetchInputOptions {
  api: FilesApi;
  fileIds: string[];
  signal: AbortSignal;
  workDir: string;
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
  const { api, fileIds, signal, workDir } = options;
  if (fileIds.length === 0) {
    return [];
  }
  const inbox = join(workDir, INBOX_DIR);
  mkdirSync(inbox, { recursive: true });
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
    writeFileSync(join(inbox, name), file.bytes);
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
  log: (message: string) => void;
  signal: AbortSignal;
  singleUser: boolean;
  text: string;
  workDir: string;
}

export interface UploadedOutputs {
  fileIds: string[];
  /** The answer without its markers, plus a note for each file that did not go. */
  text: string;
}

const refusedAsUnsupported = (paths: string[]): RejectedFile[] =>
  paths.map((path) => ({
    name: basename(path),
    path,
    reason: "outside_root",
  }));

/**
 * Uploads the files that the answer's `[ATTACHMENT:path]` markers name and
 * returns the ids. A marker that is refused (outside the work directory,
 * missing, over 50 MB) or whose upload fails leaves a note in the text and no
 * id; the run itself still counts as done. Aborting stops the uploads and
 * rejects.
 */
export const uploadOutputs = async (
  options: UploadOutputOptions
): Promise<UploadedOutputs> => {
  const { api, log, signal, text, workDir } = options;
  const extracted = extractAttachmentMarkers(text);
  if (extracted.paths.length === 0) {
    return { fileIds: [], text };
  }
  if (!options.singleUser) {
    log(`attachments refused: ${MULTI_USER_FILES_MESSAGE}`);
    return {
      fileIds: [],
      text: [
        extracted.text,
        ...refusedAsUnsupported(extracted.paths).map(rejectionNote),
      ]
        .join("\n")
        .trim(),
    };
  }
  const { files, rejected } = resolveOutboundFiles(extracted.paths, {
    maxBytes: MAX_OUTBOUND_BYTES,
    workDir,
  });
  for (const refused of rejected) {
    log(`attachment ${refused.path} refused: ${refused.reason}`);
  }
  const notes = rejected.map(rejectionNote);
  const fileIds: string[] = [];
  for (const file of files) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: uploads go one at a time, so a slow link is not asked for 50 MB several times at once.
      const uploaded = await api.upload(
        { body: bunFile(file.path), name: file.name },
        signal
      );
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
