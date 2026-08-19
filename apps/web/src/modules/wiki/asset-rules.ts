export const MAX_WIKI_ASSET_BYTES = 20 * 1024 * 1024;

/**
 * Wiki assets are illustrations and reference documents embedded in pages.
 * `image/svg+xml` is deliberately absent: SVG is script-capable, and these files
 * are served back from our own origin.
 */
export const ALLOWED_WIKI_ASSET_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "application/json",
  "text/plain",
  "text/markdown",
  "text/csv",
] as const;

export type AllowedWikiAssetMimeType =
  (typeof ALLOWED_WIKI_ASSET_MIME_TYPES)[number];

export type WikiAssetValidation =
  | { ok: true; filename: string; mime: AllowedWikiAssetMimeType }
  | { ok: false; reason: string };

const MIME_PARAMETER_SEPARATOR = ";";
const PATH_SEPARATOR = /[\\/]/;
// Quotes, backslashes and control characters would break - or let a caller
// forge - the Content-Disposition header, so they never reach a filename.
const UNSAFE_FILENAME_CHARACTERS = /["\\\p{Cc}]/gu;

const normalizeMimeType = (mime: string): string =>
  mime.split(MIME_PARAMETER_SEPARATOR)[0]?.trim().toLowerCase() ?? "";

const isAllowedMimeType = (mime: string): mime is AllowedWikiAssetMimeType =>
  (ALLOWED_WIKI_ASSET_MIME_TYPES as readonly string[]).includes(mime);

/** Drops any directory component a browser may have sent with the file name. */
const sanitizeFilename = (filename: string): string =>
  (filename.split(PATH_SEPARATOR).at(-1) ?? "")
    .replace(UNSAFE_FILENAME_CHARACTERS, "")
    .trim();

export const isInlineWikiAsset = (mime: string): boolean =>
  normalizeMimeType(mime).startsWith("image/");

export const validateWikiAsset = ({
  filename,
  mime,
  size,
}: {
  filename: string;
  mime: string;
  size: number;
}): WikiAssetValidation => {
  const safeFilename = sanitizeFilename(filename);
  if (safeFilename.length === 0) {
    return { ok: false, reason: "A filename is required." };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: "The file is empty." };
  }
  if (size > MAX_WIKI_ASSET_BYTES) {
    const limitInMegabytes = MAX_WIKI_ASSET_BYTES / (1024 * 1024);
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
