// The daemon's HTTP client for the Worker's file routes. It authenticates with
// the run token, never the machine credential. File bodies go out and come
// back untouched; only error text is masked, so a secret that an error answer
// carries never reaches a thrown message or a log.

import type { Masker } from "@repo/protocol/masker";
import { RunApiError } from "./run-api.ts";

/** The status a RunApiError carries when no HTTP answer was usable. */
const NO_ANSWER = 0;
const ERROR_TEXT_LIMIT = 200;
const RUN_TOKEN_PLACEHOLDER = "[secret:run_token]";
const TRAILING_SLASHES = /\/+$/;
const PATH_SEPARATOR = /[/\\]/;
const CONTROL_CHARACTER = /\p{Cc}/gu;
const LEADING_DOTS = /^\.+/;
const FILENAME_STAR = /filename\*\s*=\s*UTF-8''([^;]+)/i;
const FILENAME_PLAIN = /filename\s*=\s*(?:"([^"]*)"|([^;\s]*))/i;
const FALLBACK_NAME = "file";

/** How long one file request may take. */
export const FILE_REQUEST_TIMEOUT_MS = 120_000;

export interface FilesApi {
  /** GET <server>/files/<id> with `Authorization: Bearer <runToken>`. Throws RunApiError on a non-2xx answer (status carried). */
  download: (
    fileId: string,
    signal?: AbortSignal
  ) => Promise<{ body: Blob; name: string }>;
  /** POST <server>/api/files, multipart/form-data with one `file` field, same bearer. Resolves with the new file's id. Throws RunApiError on a non-2xx answer or an answer without a string `id`. */
  upload: (
    file: { body: Blob; name: string },
    signal?: AbortSignal
  ) => Promise<{ id: string }>;
}

export interface FilesApiOptions {
  fetch: typeof fetch;
  masker: Masker;
  /** The run token, `hm_run_...`. */
  runToken: string;
  /** Worker origin; trailing slashes are tolerated. */
  server: string;
}

/** The parsed body, or null when the body is not JSON. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Built outside a catch block, so the cause is passed on in one place. */
const noAnswerError = (message: string, cause: unknown): RunApiError =>
  new RunApiError(message, NO_ANSWER, { cause });

/** The string under `key` of a JSON object answer, or undefined for any other body. */
const stringField = (text: string, key: string): string | undefined => {
  const value = parseJson(text);
  if (typeof value !== "object" || value === null || !(key in value)) {
    return;
  }
  const field = value[key as keyof typeof value];
  return typeof field === "string" ? field : undefined;
};

const decodeOrUndefined = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value);
  } catch {
    // Not valid percent-encoding. The caller falls back to filename.
  }
};

/** The name a Content-Disposition header gives, or "" when it gives none. */
const dispositionName = (header: string | null): string => {
  if (header === null) {
    return "";
  }
  const encoded = FILENAME_STAR.exec(header)?.[1];
  const decoded =
    encoded === undefined ? undefined : decodeOrUndefined(encoded.trim());
  if (decoded !== undefined) {
    return decoded;
  }
  const plain = FILENAME_PLAIN.exec(header);
  return plain?.[1] ?? plain?.[2] ?? "";
};

/** Reduces a name the peer chose to a plain file name that cannot escape a folder. */
const safeFileName = (raw: string): string => {
  const base = raw.split(PATH_SEPARATOR).pop() ?? "";
  const cleaned = base
    .replace(CONTROL_CHARACTER, "_")
    .replace(LEADING_DOTS, "");
  return cleaned === "" ? FALLBACK_NAME : cleaned;
};

export const createFilesApi = (options: FilesApiOptions): FilesApi => {
  const { masker, runToken } = options;
  const doFetch = options.fetch;
  const base = options.server.replace(TRAILING_SLASHES, "");
  const authorization = `Bearer ${runToken}`;

  // Masks, then removes the run token itself, so a server that echoes the
  // token back cannot put it in an error message.
  const scrub = (text: string): string => {
    const masked = masker.mask(text);
    return runToken === ""
      ? masked
      : masked.split(runToken).join(RUN_TOKEN_PLACEHOLDER);
  };

  const requestSignal = (signal?: AbortSignal): AbortSignal => {
    const timeout = AbortSignal.timeout(FILE_REQUEST_TIMEOUT_MS);
    return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  };

  const send = async (
    route: string,
    url: string,
    init: RequestInit
  ): Promise<Response> => {
    try {
      return await doFetch(url, init);
    } catch (error) {
      throw noAnswerError(
        scrub(`files ${route} request failed before an answer`),
        error
      );
    }
  };

  const failure = async (
    route: string,
    response: Response
  ): Promise<RunApiError> => {
    const text = await response.text().catch(() => "");
    const error = stringField(text, "error");
    const detail =
      error === undefined ? "" : `: ${scrub(error).slice(0, ERROR_TEXT_LIMIT)}`;
    return new RunApiError(
      scrub(`files ${route} answered HTTP ${response.status}${detail}`),
      response.status
    );
  };

  const download = async (
    fileId: string,
    signal?: AbortSignal
  ): Promise<{ body: Blob; name: string }> => {
    const response = await send(
      "download",
      `${base}/files/${encodeURIComponent(fileId)}`,
      {
        headers: { authorization },
        method: "GET",
        signal: requestSignal(signal),
      }
    );
    if (!response.ok) {
      throw await failure("download", response);
    }
    let body: Blob;
    try {
      // @types/node and bun-types declare two Blob types. At runtime they are one class.
      body = (await response.blob()) as Blob;
    } catch (error) {
      throw noAnswerError(
        scrub("files download answer could not be read"),
        error
      );
    }
    const name = safeFileName(
      dispositionName(response.headers.get("content-disposition"))
    );
    return { body, name };
  };

  const upload = async (
    file: { body: Blob; name: string },
    signal?: AbortSignal
  ): Promise<{ id: string }> => {
    const form = new FormData();
    form.append(
      "file",
      new File([file.body], file.name, { type: file.body.type })
    );
    const response = await send("upload", `${base}/api/files`, {
      body: form,
      headers: { authorization },
      method: "POST",
      signal: requestSignal(signal),
    });
    if (!response.ok) {
      throw await failure("upload", response);
    }
    const id = stringField(await response.text().catch(() => ""), "id");
    if (id === undefined) {
      throw new RunApiError(
        scrub("files upload answer carries no file id"),
        NO_ANSWER
      );
    }
    return { id };
  };

  return { download, upload };
};
