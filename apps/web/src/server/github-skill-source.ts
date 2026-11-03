import {
  type FetchedSkillTree,
  type GithubSkillFetcher,
  githubSkillSourceSchema,
  SKILLS_MAX_BYTES,
  SKILLS_MAX_FILES,
} from "@repo/protocol/skills";

export type GithubSkillSourceErrorCode =
  | "invalid_archive"
  | "limit_exceeded"
  | "not_found"
  | "rate_limited"
  | "request_failed";

export class GithubSkillSourceError extends Error {
  override readonly name = "GithubSkillSourceError";
  readonly code: GithubSkillSourceErrorCode;

  constructor(
    code: GithubSkillSourceErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
  }
}

// Validation (including the MIT-attributed trueforge rules) lives in the port.
export const parseSource = (source: unknown) =>
  githubSkillSourceSchema.parse(source);

const GIT_SUFFIX = /\.git$/;
const SHA = /^[a-f0-9]{40}$/i;
const OCTAL = /^[0-7]+$/;
const DECIMAL = /^\d+$/;
const EDGE_SLASHES = /^\/+|\/+$/g;
const UNSAFE_CHARACTERS = /[\\\p{Cc}]/u;
// Interpret the 50 MB download default as MiB, matching the store's binary MB caps.
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const PAX_TYPES = new Set(["g", "x"]);
const PAX_MAX_BYTES = 64 * 1024;
const BLOCK_SIZE = 512;
const decoder = new TextDecoder("utf-8", { fatal: true });

function invalidArchive(message: string): never {
  throw new GithubSkillSourceError(
    "invalid_archive",
    `Invalid GitHub tar archive: ${message}`
  );
}

const limitExceeded = (message: string): never => {
  throw new GithubSkillSourceError("limit_exceeded", message);
};

const safePath = (path: string): void => {
  if (
    path === "" ||
    path.startsWith("/") ||
    UNSAFE_CHARACTERS.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    invalidArchive(`unsafe path "${path}" (empty or traversal segment)`);
  }
};

/** Counts bytes before forwarding them; it also propagates upstream cancellation. */
const bounded = (
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  max: number,
  message: string
) => {
  let count = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        count += chunk.byteLength;
        if (count > max) {
          limitExceeded(message);
        }
        controller.enqueue(chunk);
      },
    })
  );
};

/** Only retained entries allocate their full contents; skipped entries use one stream chunk. */
class TarReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array();
  private offset = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async consume(length: number, retain = false): Promise<Uint8Array> {
    const result = new Uint8Array(retain ? length : 0);
    let consumed = 0;
    while (consumed < length) {
      if (this.offset === this.chunk.length) {
        // biome-ignore lint/performance/noAwaitInLoops: chunks of one tar entry must be read in order
        const next = await this.reader.read();
        if (next.done) {
          invalidArchive("truncated tar entry");
        }
        this.chunk = next.value;
        this.offset = 0;
      }
      const size = Math.min(length - consumed, this.chunk.length - this.offset);
      if (retain) {
        result.set(
          this.chunk.subarray(this.offset, this.offset + size),
          consumed
        );
      }
      this.offset += size;
      consumed += size;
    }
    return result;
  }

  async finish(): Promise<void> {
    // Drain through gzip's trailer and the download counter, even after tar's end marker.
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: draining one stream validates gzip and the download cap
      if ((await this.reader.read()).done) {
        return;
      }
    }
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // A failed decompressor is already errored; preserve the original failure.
    } finally {
      this.reader.releaseLock();
    }
  }
}

const textField = (
  header: Uint8Array,
  start: number,
  length: number
): string => {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
};

const octalField = (
  header: Uint8Array,
  start: number,
  length: number
): number => {
  const text = textField(header, start, length).trim();
  if (text !== "" && !OCTAL.test(text)) {
    invalidArchive("invalid octal header field");
  }
  const value = text === "" ? 0 : Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    invalidArchive("tar size is too large");
  }
  return value;
};

const tarHeader = (header: Uint8Array) => {
  const checksum = header.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
    0
  );
  if (checksum !== octalField(header, 148, 8)) {
    invalidArchive("header checksum mismatch");
  }
  const prefix = textField(header, 345, 155);
  const name = textField(header, 0, 100);
  return {
    mode: octalField(header, 100, 8),
    name: prefix ? `${prefix}/${name}` : name,
    size: octalField(header, 124, 12),
    type: textField(header, 156, 1),
  };
};

/** Git archive uses PAX for long names, and a global PAX comment for the commit. */
const paxFields = (bytes: Uint8Array): Map<string, string> => {
  const fields = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    const sizeText = decoder.decode(bytes.subarray(offset, space));
    const size = Number(sizeText);
    if (
      space < offset ||
      !DECIMAL.test(sizeText) ||
      !Number.isSafeInteger(size) ||
      size <= space - offset + 1 ||
      offset + size > bytes.length ||
      bytes[offset + size - 1] !== 10
    ) {
      invalidArchive("malformed PAX metadata");
    }
    const record = decoder.decode(bytes.subarray(space + 1, offset + size - 1));
    const equals = record.indexOf("=");
    if (equals <= 0) {
      invalidArchive("malformed PAX field");
    }
    const key = record.slice(0, equals);
    if (fields.has(key)) {
      invalidArchive("duplicate PAX field");
    }
    fields.set(key, record.slice(equals + 1));
    offset += size;
  }
  return fields;
};

const selectedFile = (
  files: FetchedSkillTree["files"],
  path: string,
  size: number,
  total: number
): void => {
  // The store has one total byte cap, so a single file uses that same cap.
  if (
    files.length >= SKILLS_MAX_FILES ||
    size > SKILLS_MAX_BYTES ||
    total + size > SKILLS_MAX_BYTES
  ) {
    limitExceeded(
      `GitHub skill exceeds ${SKILLS_MAX_FILES} files or ${SKILLS_MAX_BYTES} bytes (5 MiB)`
    );
  }
  // Match the store's relative-path bounds before retaining a file's bytes.
  if (
    new TextEncoder().encode(path).length > 512 ||
    path.split("/").length > 20
  ) {
    invalidArchive("skill path exceeds the store's path limits");
  }
  for (const file of files) {
    if (
      file.path === path ||
      file.path.startsWith(`${path}/`) ||
      path.startsWith(`${file.path}/`)
    ) {
      invalidArchive(`duplicate path or file/folder collision at "${path}"`);
    }
  }
};

type TarEntry = ReturnType<typeof tarHeader>;

const applyPax = (entry: TarEntry, fields: Map<string, string>): TarEntry => {
  const size = fields.get("size");
  if (size !== undefined) {
    if (!(DECIMAL.test(size) && Number.isSafeInteger(Number(size)))) {
      invalidArchive("invalid PAX size");
    }
    entry.size = Number(size);
  }
  entry.name = fields.get("path") ?? entry.name;
  return entry;
};

const globalPax = (fields: Map<string, string>): void => {
  if (fields.has("path") || fields.has("size") || fields.has("linkpath")) {
    invalidArchive("global PAX path/size overrides are unsupported");
  }
};

async function* tarEntries(reader: TarReader): AsyncGenerator<TarEntry> {
  let pax = new Map<string, string>();
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: tar headers and bodies share one sequential stream
    const block = await reader.consume(BLOCK_SIZE, true);
    if (block.every((byte) => byte === 0)) {
      if (pax.size > 0) {
        invalidArchive("PAX header without an entry");
      }
      await reader.finish();
      return;
    }
    const entry = tarHeader(block);
    if (PAX_TYPES.has(entry.type)) {
      if (entry.size > PAX_MAX_BYTES) {
        invalidArchive("PAX metadata exceeds 64 KiB");
      }
      const fields = paxFields(await reader.consume(entry.size, true));
      if (entry.type === "x") {
        if (pax.size > 0) {
          invalidArchive("repeated PAX header");
        }
        pax = fields;
      } else {
        globalPax(fields);
      }
    } else {
      yield applyPax(entry, pax);
      pax = new Map();
    }
    await reader.consume((BLOCK_SIZE - (entry.size % BLOCK_SIZE)) % BLOCK_SIZE);
  }
}

const readTree = async (
  reader: TarReader,
  commitSha: string,
  path: string | undefined
): Promise<FetchedSkillTree> => {
  const files: FetchedSkillTree["files"] = [];
  let total = 0;
  let top: string | undefined;
  const selected = path ? `${path.replace(EDGE_SLASHES, "")}/` : "";
  for await (const entry of tarEntries(reader)) {
    const name = entry.name.endsWith("/")
      ? entry.name.slice(0, -1)
      : entry.name;
    safePath(name);
    const slash = name.indexOf("/");
    const root = slash < 0 ? name : name.slice(0, slash);
    // Codeload top-folder naming varies; require one root, rather than guessing its spelling.
    top ??= root;
    if (root !== top) {
      invalidArchive("multiple top-level archive paths");
    }
    const relative = slash < 0 ? "" : name.slice(slash + 1);
    const included = relative !== "" && relative.startsWith(selected);
    // Links outside the selected folder are skipped like other unrelated entries.
    if (!included || entry.type === "5") {
      await reader.consume(entry.size);
      continue;
    }
    if (entry.type !== "0" && entry.type !== "") {
      invalidArchive(
        `links and special files are forbidden at path "${relative}"`
      );
    }
    const filePath = relative.slice(selected.length);
    safePath(filePath);
    selectedFile(files, filePath, entry.size, total);
    const bytes = await reader.consume(entry.size, true);
    files.push({
      bytes,
      // biome-ignore lint/suspicious/noBitwiseOperators: tar mode bits encode Unix execute permissions
      executable: (entry.mode & 0o111) !== 0,
      path: filePath,
    });
    total += entry.size;
  }
  if (!files.some((file) => file.path === "SKILL.md")) {
    invalidArchive("selected skill folder must contain SKILL.md");
  }
  return { commitSha, files };
};

const requestHeaders = (token?: string, accept?: string): Headers => {
  const headers = new Headers({
    "User-Agent": "Agentum-GitHub-Skill-Fetcher",
  });
  if (accept) {
    headers.set("Accept", accept);
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
};

const githubResponse = async (response: Response): Promise<Response> => {
  if (response.ok) {
    return response;
  }
  await response.body?.cancel();
  if (response.status === 404) {
    throw new GithubSkillSourceError(
      "not_found",
      "GitHub repository, ref or skill archive not found. Check the repository URL and ref."
    );
  }
  // GitHub answers 422, not 404, when a branch, tag or commit does not exist.
  if (response.status === 422) {
    throw new GithubSkillSourceError(
      "not_found",
      "GitHub could not find that ref. Check the branch, tag or commit."
    );
  }
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("X-RateLimit-Remaining") === "0" ||
        response.headers.has("Retry-After")))
  ) {
    const retry = response.headers.get("Retry-After");
    const reset = response.headers.get("X-RateLimit-Reset");
    const hint = retry
      ? `Retry after ${retry} seconds.`
      : `Please retry later${reset ? ` (rate limit resets at Unix time ${reset})` : ""}.`;
    throw new GithubSkillSourceError(
      "rate_limited",
      `GitHub rate limit exceeded. ${hint}`
    );
  }
  throw new GithubSkillSourceError(
    "request_failed",
    `GitHub request failed (HTTP ${response.status}).`
  );
};

export type GithubSkillFetch = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

/** Pure apart from the injected fetch; optional credentials are supplied by the caller. */
export const createGithubSkillFetcher = (
  fetch: GithubSkillFetch
): GithubSkillFetcher => {
  const request = async (url: string, headers: Headers): Promise<Response> => {
    try {
      return await githubResponse(await fetch(url, { headers }));
    } catch (error) {
      if (error instanceof GithubSkillSourceError) {
        throw error;
      }
      // biome-ignore lint/style/useErrorCause: custom error accepts ErrorOptions as its third argument
      throw new GithubSkillSourceError(
        "request_failed",
        "GitHub request failed. Please retry later.",
        { cause: error }
      );
    }
  };
  const repository = (repoUrl: string, ref: string, path?: string) => {
    const source = parseSource({ path, provider: "github", ref, repoUrl });
    const repo = new URL(source.repoUrl).pathname
      .replace(EDGE_SLASHES, "")
      .replace(GIT_SUFFIX, "");
    return { repo, source };
  };
  return {
    async fetchTree(repoUrl, commitSha, path, token) {
      const { repo, source } = repository(repoUrl, commitSha, path);
      if (!SHA.test(commitSha)) {
        throw new GithubSkillSourceError(
          "request_failed",
          "Fetching a skill requires an exact 40-character commit SHA."
        );
      }
      const response = await request(
        `https://codeload.github.com/${repo}/tar.gz/${commitSha}`,
        requestHeaders(token)
      );
      if (!response.body) {
        invalidArchive("missing gzip body");
      }
      const stream = bounded(
        response.body,
        DOWNLOAD_MAX_BYTES,
        "GitHub archive download exceeds 50 MiB."
      ).pipeThrough(new DecompressionStream("gzip"));
      const reader = new TarReader(stream);
      try {
        return await readTree(reader, commitSha, source.path);
      } catch (error) {
        if (error instanceof GithubSkillSourceError) {
          throw error;
        }
        return invalidArchive("could not decode gzip/tar data");
      } finally {
        await reader.close();
      }
    },
    async resolveCommit(repoUrl, ref, token) {
      const { repo, source } = repository(repoUrl, ref);
      const response = await request(
        `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(source.ref)}`,
        requestHeaders(token, "application/vnd.github.sha")
      );
      if (!response.body) {
        throw new GithubSkillSourceError(
          "request_failed",
          "GitHub returned no commit SHA."
        );
      }
      let commitSha: string;
      try {
        commitSha = (
          await new Response(
            bounded(
              response.body,
              1024,
              "GitHub commit SHA response exceeds 1024 bytes."
            )
          ).text()
        ).trim();
      } catch (error) {
        // biome-ignore lint/style/useErrorCause: custom error accepts ErrorOptions as its third argument
        throw new GithubSkillSourceError(
          "request_failed",
          "GitHub returned an invalid commit SHA response.",
          { cause: error }
        );
      }
      if (!SHA.test(commitSha)) {
        throw new GithubSkillSourceError(
          "request_failed",
          "GitHub returned an invalid commit SHA."
        );
      }
      return commitSha;
    },
  };
};
