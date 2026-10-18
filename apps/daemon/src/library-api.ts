// The daemon's HTTP client for a run's view of the workspace library on the
// Worker. It authenticates with the run token, never the machine credential.
// File bodies go up and come back untouched; only error text is masked, so a
// secret that an error answer carries never reaches a thrown message or a log.

import type { RemoteEntry, RemotePort } from "@repo/library-sync";
import {
  LIBRARY_ETAG_HEADER,
  LIBRARY_IF_ETAG_HEADER,
  libraryListResponseSchema,
  libraryStatResponseSchema,
  libraryWriteResponseSchema,
} from "@repo/protocol/library";
import type { Masker } from "@repo/protocol/masker";
import type { ZodType } from "zod";
import { RunApiError } from "./run-api.ts";

/** The status a RunApiError carries when no HTTP answer was usable. */
const NO_ANSWER = 0;
const BAD_REQUEST = 400;
const NOT_FOUND = 404;
const CONFLICT = 409;
const ERROR_TEXT_LIMIT = 200;
const RUN_TOKEN_PLACEHOLDER = "[secret:run_token]";
const TRAILING_SLASHES = /\/+$/;

/** How long one library request may take. */
export const LIBRARY_REQUEST_TIMEOUT_MS = 120_000;

export interface LibraryApi extends RemotePort {
  /** POST conflicts. Throws RunApiError on a non-2xx answer. */
  recordConflict: (conflict: {
    conflictPath: string;
    path: string;
  }) => Promise<void>;
}

export interface LibraryApiOptions {
  fetch: typeof fetch;
  masker: Masker;
  runId: string;
  /** The run token, `hm_run_...`. */
  runToken: string;
  /** Worker origin; trailing slashes are tolerated. */
  server: string;
  /** Cancels every request when aborted. */
  signal?: AbortSignal;
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

export const createLibraryApi = (options: LibraryApiOptions): LibraryApi => {
  const { masker, runToken, signal } = options;
  const doFetch = options.fetch;
  const base = `${options.server.replace(TRAILING_SLASHES, "")}/api/runs/${encodeURIComponent(options.runId)}/library`;
  const authorization = `Bearer ${runToken}`;

  // Masks, then removes the run token itself, so a server that echoes the
  // token back cannot put it in an error message.
  const scrub = (text: string): string => {
    const masked = masker.mask(text);
    return runToken === ""
      ? masked
      : masked.split(runToken).join(RUN_TOKEN_PLACEHOLDER);
  };

  const requestSignal = (): AbortSignal => {
    const timeout = AbortSignal.timeout(LIBRARY_REQUEST_TIMEOUT_MS);
    return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  };

  const send = async (
    route: string,
    url: string,
    init: {
      body?: Uint8Array | string;
      headers?: Record<string, string>;
      method: string;
    }
  ): Promise<Response> => {
    try {
      return await doFetch(url, {
        body: init.body,
        headers: { authorization, ...init.headers },
        method: init.method,
        signal: requestSignal(),
      });
    } catch (error) {
      throw noAnswerError(
        scrub(`library ${route} request failed before an answer`),
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
      scrub(`library ${route} answered HTTP ${response.status}${detail}`),
      response.status
    );
  };

  const parseAnswer = async <T>(
    route: string,
    schema: ZodType<T>,
    response: Response
  ): Promise<T> => {
    const parsed = schema.safeParse(
      parseJson(await response.text().catch(() => ""))
    );
    if (!parsed.success) {
      throw new RunApiError(
        scrub(`library ${route} answer does not match the protocol`),
        NO_ANSWER
      );
    }
    return parsed.data;
  };

  const filePath = (path: string): string =>
    `${base}/file?path=${encodeURIComponent(path)}`;

  const list = async (dir: string): Promise<RemoteEntry[]> => {
    const response = await send(
      "list",
      `${base}/list?path=${encodeURIComponent(dir)}`,
      { method: "GET" }
    );
    if (response.status === NOT_FOUND) {
      return [];
    }
    if (!response.ok) {
      throw await failure("list", response);
    }
    const answer = await parseAnswer(
      "list",
      libraryListResponseSchema,
      response
    );
    return answer.entries;
  };

  const stat = async (path: string): Promise<RemoteEntry | null> => {
    const response = await send(
      "stat",
      `${base}/stat?path=${encodeURIComponent(path)}`,
      { method: "GET" }
    );
    if (response.status === NOT_FOUND) {
      return null;
    }
    if (!response.ok) {
      throw await failure("stat", response);
    }
    const answer = await parseAnswer(
      "stat",
      libraryStatResponseSchema,
      response
    );
    return answer.entry;
  };

  const read = async (
    path: string
  ): Promise<{ bytes: Uint8Array; etag: string } | null> => {
    const response = await send("file", filePath(path), { method: "GET" });
    // A folder answers 400, so there are no bytes to read.
    if (response.status === NOT_FOUND || response.status === BAD_REQUEST) {
      return null;
    }
    if (!response.ok) {
      throw await failure("file", response);
    }
    const etag = response.headers.get(LIBRARY_ETAG_HEADER);
    if (etag === null) {
      throw new RunApiError(
        scrub("library file answer has no etag header"),
        NO_ANSWER
      );
    }
    try {
      return { bytes: new Uint8Array(await response.arrayBuffer()), etag };
    } catch (error) {
      throw noAnswerError(
        scrub("library file answer could not be read"),
        error
      );
    }
  };

  const write = async (
    path: string,
    bytes: Uint8Array,
    writeOptions?: { ifEtag?: string }
  ): Promise<{ etag: string } | null> => {
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
    };
    if (writeOptions?.ifEtag !== undefined) {
      headers[LIBRARY_IF_ETAG_HEADER] = writeOptions.ifEtag;
    }
    const response = await send("write", filePath(path), {
      body: bytes,
      headers,
      method: "PUT",
    });
    // The file changed since the etag the caller holds.
    if (response.status === CONFLICT) {
      return null;
    }
    if (!response.ok) {
      throw await failure("write", response);
    }
    const answer = await parseAnswer(
      "write",
      libraryWriteResponseSchema,
      response
    );
    return { etag: answer.etag };
  };

  const remove = async (path: string): Promise<void> => {
    const response = await send("delete", filePath(path), {
      method: "DELETE",
    });
    if (response.status !== NOT_FOUND && !response.ok) {
      throw await failure("delete", response);
    }
  };

  const recordConflict = async (conflict: {
    conflictPath: string;
    path: string;
  }): Promise<void> => {
    const response = await send("conflicts", `${base}/conflicts`, {
      body: JSON.stringify({
        conflictPath: conflict.conflictPath,
        path: conflict.path,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      throw await failure("conflicts", response);
    }
  };

  return {
    delete: remove,
    list,
    read,
    recordConflict,
    stat,
    write,
  };
};
