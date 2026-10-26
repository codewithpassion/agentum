// The remote side of a library transfer for a script that runs outside the
// Worker. It calls the library routes over HTTPS with a bearer token. The file
// is bundled into a script, so it imports only `./types.ts` and parses JSON
// with plain type guards.

import type { RemoteEntry, RemotePort } from "./types.ts";

export interface FetchRemote extends RemotePort {
  /** POST conflicts. Throws on a non-2xx answer. */
  recordConflict: (conflict: {
    conflictPath: string;
    path: string;
  }) => Promise<void>;
  /** GET run: the id of the run this token belongs to. */
  runId: () => Promise<string>;
}

export interface FetchRemoteOptions {
  /** The library route prefix, such as `https://host/api/session/library`. Trailing slashes are dropped. */
  base: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  token: string;
}

const NOT_FOUND = 404;
const BAD_REQUEST = 400;
const CONFLICT = 409;
const ETAG_HEADER = "X-Library-Etag";
const IF_ETAG_HEADER = "X-Library-If-Etag";
const ERROR_TEXT_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 120_000;
const TRAILING_SLASHES = /\/+$/;
const TOKEN_PLACEHOLDER = "[token]";

interface ListAnswer {
  entries: RemoteEntry[];
}

interface StatAnswer {
  entry: RemoteEntry | null;
}

interface WriteAnswer {
  etag: string;
}

interface RunAnswer {
  runId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEntry = (value: unknown): value is RemoteEntry =>
  isRecord(value) &&
  (typeof value.etag === "string" || value.etag === null) &&
  (value.kind === "dir" || value.kind === "file") &&
  typeof value.path === "string" &&
  typeof value.size === "number";

const isListAnswer = (value: unknown): value is ListAnswer =>
  isRecord(value) &&
  Array.isArray(value.entries) &&
  value.entries.every(isEntry);

const isStatAnswer = (value: unknown): value is StatAnswer =>
  isRecord(value) && (value.entry === null || isEntry(value.entry));

const isWriteAnswer = (value: unknown): value is WriteAnswer =>
  isRecord(value) && typeof value.etag === "string";

const isRunAnswer = (value: unknown): value is RunAnswer =>
  isRecord(value) && typeof value.runId === "string";

/** The parsed JSON body, or null when the text is not JSON. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The `error` field of a JSON object answer, or undefined for any other body. */
const errorField = (text: string): string | undefined => {
  const value = parseJson(text);
  return isRecord(value) && typeof value.error === "string"
    ? value.error
    : undefined;
};

export const createFetchRemote = (options: FetchRemoteOptions): FetchRemote => {
  const { token } = options;
  const base = options.base.replace(TRAILING_SLASHES, "");
  const doFetch = options.fetch ?? fetch;
  const authorization = `Bearer ${token}`;

  // Replaces every copy of the token, so a server that echoes it back cannot
  // put it in a thrown message.
  const scrub = (text: string): string =>
    token === "" ? text : text.split(token).join(TOKEN_PLACEHOLDER);

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
        // Bytes read from disk or the wire are backed by an ArrayBuffer, which a body takes.
        body: init.body as Uint8Array<ArrayBuffer> | string | undefined,
        headers: { authorization, ...init.headers },
        method: init.method,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new Error(`library ${route} request failed`, { cause });
    }
  };

  const failure = async (route: string, response: Response): Promise<Error> => {
    const text = await response.text().catch(() => "");
    const error = errorField(text);
    const detail =
      error === undefined ? "" : `: ${scrub(error).slice(0, ERROR_TEXT_LIMIT)}`;
    return new Error(
      `library ${route} answered HTTP ${response.status}${detail}`
    );
  };

  const answerOf = async <T>(
    route: string,
    response: Response,
    isAnswer: (value: unknown) => value is T
  ): Promise<T> => {
    const value = parseJson(await response.text().catch(() => ""));
    if (!isAnswer(value)) {
      throw new Error(`library ${route} answer does not match the protocol`);
    }
    return value;
  };

  const fileUrl = (path: string): string =>
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
    return (await answerOf("list", response, isListAnswer)).entries;
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
    return (await answerOf("stat", response, isStatAnswer)).entry;
  };

  const read = async (
    path: string
  ): Promise<{ bytes: Uint8Array; etag: string } | null> => {
    const response = await send("file", fileUrl(path), { method: "GET" });
    // A folder answers 400, so there are no bytes to read.
    if (response.status === NOT_FOUND || response.status === BAD_REQUEST) {
      return null;
    }
    if (!response.ok) {
      throw await failure("file", response);
    }
    const etag = response.headers.get(ETAG_HEADER);
    if (etag === null) {
      throw new Error("library file answer has no etag header");
    }
    try {
      return { bytes: new Uint8Array(await response.arrayBuffer()), etag };
    } catch (cause) {
      throw new Error("library file request failed", { cause });
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
      headers[IF_ETAG_HEADER] = writeOptions.ifEtag;
    }
    const response = await send("write", fileUrl(path), {
      body: bytes,
      headers,
      method: "PUT",
    });
    // The file is not there with the etag the caller holds.
    if (response.status === CONFLICT) {
      return null;
    }
    if (!response.ok) {
      throw await failure("write", response);
    }
    const answer = await answerOf("write", response, isWriteAnswer);
    return { etag: answer.etag };
  };

  const remove = async (path: string): Promise<void> => {
    const response = await send("delete", fileUrl(path), { method: "DELETE" });
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

  const runId = async (): Promise<string> => {
    const response = await send("run", `${base}/run`, { method: "GET" });
    if (!response.ok) {
      throw await failure("run", response);
    }
    return (await answerOf("run", response, isRunAnswer)).runId;
  };

  return {
    delete: remove,
    list,
    read,
    recordConflict,
    runId,
    stat,
    write,
  };
};
