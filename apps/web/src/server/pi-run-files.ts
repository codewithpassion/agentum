// A cloud run's files. There is no file system in a cloud agent: its work
// directory is the workspace library, mounted at `/library` in its `bash` tool.
// Input files reach the model before the first turn, as image blocks or as a
// list it reads with `read_input_file`. After a run, the `[ATTACHMENT:path]`
// markers in the answer are uploaded from the library and replaced by file ids.
// Mirrors apps/daemon/src/run-files.ts where the two runtimes share a rule.

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type Extension } from "@earendil-works/pi-durable";
import { MAX_FILE_BYTES } from "@repo/db/shared";
import { extractAttachmentMarkers } from "@repo/protocol/attachments";

export const FILES_EXTENSION = "hm-files";
export const LIBRARY_ROOT = "/library";

const LIBRARY_PREFIX = `${LIBRARY_ROOT}/`;
const DOT_SLASH = "./";
const PARENT_SEGMENT = "..";
const ABSOLUTE_PREFIX = "/";
const MIME_SEPARATOR = ";";
const EXTENSION_SEPARATOR = ".";
// A Durable Object stores a message in one SQLite row of at most 2 MB, and the images go in it as base64 (a third larger). Anthropic refuses an image over 5 MB too.
const MAX_IMAGE_TOTAL_BYTES = 1_200_000;
const MAX_OUTPUT_FILES = 100;
const MAX_TEXT_CHARS = 100_000;
// String.fromCharCode takes its arguments as a list, so the bytes go in slices.
const BASE64_CHUNK_BYTES = 0x80_00;
const FALLBACK_MIME = "application/octet-stream";
const READ_TOOL = "read_input_file";
const TRUNCATED_LINE = "\n[truncated]";

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
]);
const MIME_BY_EXTENSION = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["pdf", "application/pdf"],
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["csv", "text/csv"],
  ["json", "application/json"],
  ["html", "text/html"],
  ["xml", "application/xml"],
  ["zip", "application/zip"],
  [
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [
    "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["mp4", "video/mp4"],
]);

export interface RunFilesPort {
  /** A file the run may read (its input), by file id. Throws when it cannot be read. */
  download: (
    fileId: string
  ) => Promise<{ bytes: Uint8Array; mime: string; name: string }>;
  /** A library file by library-relative path ("reports/a.png"). null when there is no such file. Throws on other failures. */
  readLibrary: (path: string) => Promise<Uint8Array | null>;
  upload: (file: {
    bytes: Uint8Array;
    mime: string;
    name: string;
  }) => Promise<{ id: string }>;
}

export type PiInput = string | (TextContent | ImageContent)[];

interface FileBody {
  bytes: Uint8Array;
  mime: string;
  name: string;
}

/** The mime type without parameters, lower case: "Text/Plain; charset=utf-8" is "text/plain". */
const baseMime = (mime: string): string =>
  (mime.split(MIME_SEPARATOR)[0] ?? "").trim().toLowerCase();

const isImage = (mime: string): boolean => IMAGE_MIMES.has(baseMime(mime));

const isTextLike = (mime: string): boolean => {
  const base = baseMime(mime);
  return (
    base.startsWith("text/") ||
    TEXT_MIMES.has(base) ||
    base.endsWith("+json") ||
    base.endsWith("+xml")
  );
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(
      ...bytes.subarray(start, start + BASE64_CHUNK_BYTES)
    );
  }
  return btoa(binary);
};

interface Downloaded {
  file: FileBody | undefined;
  fileId: string;
}

// A failed download is an answer, not an error: a throw would make the platform retry the run forever.
const downloadOne = async (
  port: RunFilesPort,
  fileId: string
): Promise<Downloaded> => {
  try {
    return { file: await port.download(fileId), fileId };
  } catch {
    return { file: undefined, fileId };
  }
};

const listedLine = (fileId: string, file: FileBody): string => {
  const hint = isTextLike(file.mime) ? `: read it with ${READ_TOOL}` : "";
  return `- ${file.name} (${file.mime}, id ${fileId})${hint}`;
};

/**
 * The message as the model receives it. Every file is listed. Images under the
 * size cap also become image blocks. Other files are listed by name and id, and
 * the ones that could not be downloaded are listed as unreadable.
 */
export const inputContent = async (
  text: string,
  fileIds: readonly string[],
  port: RunFilesPort
): Promise<PiInput> => {
  if (fileIds.length === 0) {
    return text;
  }
  const fetched = await Promise.all(
    fileIds.map((fileId) => downloadOne(port, fileId))
  );
  const lines: string[] = [];
  const images: ImageContent[] = [];
  let imageBytes = 0;
  for (const { fileId, file } of fetched) {
    if (file === undefined) {
      lines.push(`- ${fileId} (could not be read)`);
    } else if (
      isImage(file.mime) &&
      imageBytes + file.bytes.byteLength <= MAX_IMAGE_TOTAL_BYTES
    ) {
      imageBytes += file.bytes.byteLength;
      lines.push(`- ${file.name} (${file.mime}, shown as an image below)`);
      images.push({
        data: toBase64(file.bytes),
        mimeType: file.mime,
        type: "image",
      });
    } else {
      lines.push(listedLine(fileId, file));
    }
  }
  const body =
    lines.length === 0
      ? text
      : `${text}\n\nFiles attached to this message:\n${lines.join("\n")}`;
  return [{ text: body, type: "text" }, ...images];
};

const lastSegment = (path: string): string =>
  path
    .split("/")
    .filter((segment) => segment.length > 0)
    .at(-1) ?? path;

const mimeFor = (name: string): string => {
  const dot = name.lastIndexOf(EXTENSION_SEPARATOR);
  if (dot < 0) {
    return FALLBACK_MIME;
  }
  return (
    MIME_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? FALLBACK_MIME
  );
};

/** The library-relative path a marker names, or null when it names something outside the library. */
const libraryRelative = (marker: string): string | null => {
  let relative = marker;
  if (marker.startsWith(LIBRARY_PREFIX)) {
    relative = marker.slice(LIBRARY_PREFIX.length);
  } else if (marker.startsWith(ABSOLUTE_PREFIX)) {
    return null;
  } else if (marker.startsWith(DOT_SLASH)) {
    relative = marker.slice(DOT_SLASH.length);
  }
  if (
    relative.length === 0 ||
    relative.startsWith(ABSOLUTE_PREFIX) ||
    relative.split("/").includes(PARENT_SEGMENT)
  ) {
    return null;
  }
  return relative;
};

type SendOutcome = { id: string } | { note: string };

/** Reads one marked library file and uploads it. A failure becomes a note in the answer. */
const sendMarker = async (
  port: RunFilesPort,
  marker: string
): Promise<SendOutcome> => {
  const name = lastSegment(marker);
  const relative = libraryRelative(marker);
  if (relative === null) {
    return { note: `[attachment refused: ${name}]` };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await port.readLibrary(relative);
  } catch {
    return { note: `[attachment failed: ${name}]` };
  }
  if (bytes === null) {
    return { note: `[attachment missing: ${name}]` };
  }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return { note: `[attachment refused: ${name}]` };
  }
  try {
    const uploaded = await port.upload({ bytes, mime: mimeFor(name), name });
    return { id: uploaded.id };
  } catch {
    return { note: `[attachment failed: ${name}]` };
  }
};

/**
 * Uploads the files that the answer's `[ATTACHMENT:path]` markers name and
 * returns their ids, in marker order, with the markers removed. A marker that
 * is refused, missing or failing leaves a note in the text and no id. One bad
 * file never stops the others.
 */
export const uploadOutputs = async (
  text: string,
  port: RunFilesPort
): Promise<{ fileIds: string[]; text: string }> => {
  const extracted = extractAttachmentMarkers(text);
  if (extracted.paths.length === 0) {
    return { fileIds: [], text: extracted.text };
  }
  const fileIds: string[] = [];
  const notes: string[] = [];
  for (const marker of extracted.paths) {
    if (fileIds.length >= MAX_OUTPUT_FILES) {
      // A run completes with at most MAX_OUTPUT_FILES files.
      notes.push(`[attachment refused: ${lastSegment(marker)}]`);
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: uploads go one at a time, in the order the answer names them.
    const outcome = await sendMarker(port, marker);
    if ("id" in outcome) {
      fileIds.push(outcome.id);
    } else {
      notes.push(outcome.note);
    }
  }
  return { fileIds, text: [extracted.text, ...notes].join("\n").trim() };
};

const reply = (text: string, isError: boolean) => ({
  isError,
  output: [{ text, type: "text" as const }],
});

const readInputTool = (readInput: (fileId: string) => Promise<FileBody>) =>
  defineTool({
    description:
      "Reads an input file of this message as text. Pass the file id from the message.",
    execute: async ({ id }) => {
      let file: FileBody;
      try {
        file = await readInput(id);
      } catch {
        return reply(`File ${id} could not be read`, true);
      }
      if (!isTextLike(file.mime)) {
        return reply(
          `${file.name} is a ${file.mime} file and cannot be read as text`,
          true
        );
      }
      const text = new TextDecoder().decode(file.bytes);
      if (text.length <= MAX_TEXT_CHARS) {
        return reply(text, false);
      }
      return reply(`${text.slice(0, MAX_TEXT_CHARS)}${TRUNCATED_LINE}`, false);
    },
    name: READ_TOOL,
    parameters: Type.Object({
      id: Type.String({ description: "The file id from the message." }),
    }),
    replay: "safe",
  });

/** The tool that reads input files as text. Where to write files is in the workspace instructions. */
export const filesExtension = (
  readInput: (fileId: string) => Promise<FileBody>
): Extension => ({
  name: FILES_EXTENSION,
  tools: [readInputTool(readInput)],
});
