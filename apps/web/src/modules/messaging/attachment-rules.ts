export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Deliberately excludes `image/svg+xml`: SVG is script-capable, and these files
 * are served back from our own origin.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "application/json",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
  "text/csv",
] as const;

export type AllowedAttachmentMimeType =
  (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number];

export interface AttachmentCandidate {
  filename: string;
  mime: string;
  size: number;
}

export type AttachmentValidation =
  | { ok: true; mime: AllowedAttachmentMimeType; filename: string }
  | { ok: false; reason: string };

const MIME_PARAMETER_SEPARATOR = ";";
const PATH_SEPARATOR = /[\\/]/;
// Quotes, backslashes and control characters would break - or let a caller
// forge - the Content-Disposition header, so they never reach a filename.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const UNSAFE_FILENAME_CHARACTERS = /["\\\u0000-\u001f\u007f]/g;

/** Strips parameters and casing: `Text/Plain; charset=utf-8` -> `text/plain`. */
export const normalizeMimeType = (mime: string): string =>
  mime.split(MIME_PARAMETER_SEPARATOR)[0]?.trim().toLowerCase() ?? "";

const isAllowedMimeType = (mime: string): mime is AllowedAttachmentMimeType =>
  (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime);

/** Drops any directory component a browser may have sent with the file name. */
export const sanitizeFilename = (filename: string): string =>
  (filename.split(PATH_SEPARATOR).at(-1) ?? "")
    .replace(UNSAFE_FILENAME_CHARACTERS, "")
    .trim();

export const isInlineMimeType = (mime: string): boolean =>
  normalizeMimeType(mime).startsWith("image/");

export const validateAttachment = ({
  filename,
  mime,
  size,
}: AttachmentCandidate): AttachmentValidation => {
  const safeFilename = sanitizeFilename(filename);
  if (safeFilename.length === 0) {
    return { ok: false, reason: "A filename is required." };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: "The file is empty." };
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    const limitInMegabytes = MAX_ATTACHMENT_BYTES / (1024 * 1024);
    return {
      ok: false,
      reason: `The file is larger than the ${limitInMegabytes}MB limit.`,
    };
  }
  const normalized = normalizeMimeType(mime);
  if (!isAllowedMimeType(normalized)) {
    return {
      ok: false,
      reason: `Files of type "${normalized}" are not allowed.`,
    };
  }
  return { filename: safeFilename, mime: normalized, ok: true };
};
