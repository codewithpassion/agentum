// A cloud run's input files. They reach the model before the first turn, as
// image blocks or as a list it reads with `read_input_file`. An agent saves its
// own output files in its task folder in the library, not through this module.
// Mirrors apps/daemon/src/run-files.ts where the two runtimes share a rule.

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type Extension } from "@earendil-works/pi-durable";

export const FILES_EXTENSION = "hm-files";

const MIME_SEPARATOR = ";";
// A Durable Object stores a message in one SQLite row of at most 2 MB, and the images go in it as base64 (a third larger). Anthropic refuses an image over 5 MB too.
const MAX_IMAGE_TOTAL_BYTES = 1_200_000;
const MAX_TEXT_CHARS = 100_000;
// String.fromCharCode takes its arguments as a list, so the bytes go in slices.
const BASE64_CHUNK_BYTES = 0x80_00;
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

export interface RunFilesPort {
  /** A file the run may read (its input), by file id. Throws when it cannot be read. */
  download: (
    fileId: string
  ) => Promise<{ bytes: Uint8Array; mime: string; name: string }>;
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
 * size cap also become image blocks, unless `acceptsImages` is false (a text-only
 * model): then images are listed like the other files, with their id, and no
 * image block is sent. Other files are listed by name and id, and the ones that
 * could not be downloaded are listed as unreadable.
 */
export const inputContent = async (
  text: string,
  fileIds: readonly string[],
  port: RunFilesPort,
  acceptsImages = true
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
      acceptsImages &&
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
