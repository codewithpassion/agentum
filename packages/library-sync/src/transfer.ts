// The `pull` and `push` commands of the library transfer script. The script
// runs in the Linux sandbox and copies library files between the library and
// the working copy. `runTransfer` takes the argv and env of the process and
// returns the exit code. It never throws: every failure becomes a logged line.

import { basename, dirname, join, resolve } from "node:path";
import {
  createLibrarySync,
  type LibrarySync,
  type LocalPort,
  type ManifestStore,
  type SyncRoot,
} from "./index.ts";
import { createDiskLocal, createFileManifest } from "./transfer-local.ts";
import { createFetchRemote, type FetchRemote } from "./transfer-remote.ts";

export interface TransferOptions {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  log: (line: string) => void;
}

const DEFAULT_DIR = "/workspace/library";
const LIBRARY_ROUTE = "/api/session/library";
const TRAILING_SLASHES = /\/+$/;
const EDGE_SLASHES = /^\/+|\/+$/g;
const TOKEN_PLACEHOLDER = "[token]";
const USAGE = "usage: <pull|push> [--url <origin>] [--dir <dir>] [path...]";
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

interface Config {
  base: string;
  command: "pull" | "push";
  dir: string;
  manifest: string;
  paths: string[];
  token: string;
}

interface Words {
  dir?: string;
  url?: string;
  words: string[];
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

const isUrl = (text: string): boolean => URL.canParse(text);

const writeRoot = (path: string): SyncRoot => ({ mode: "write", path });

/** Separates the two flags from the plain words. A usage problem comes back as its message. */
const splitArgs = (argv: readonly string[]): Words | string => {
  const parsed: Words = { words: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) {
      parsed.words.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (name !== "--url" && name !== "--dir") {
      return `unknown option ${name}`;
    }
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const value = inline ?? argv[index + 1];
    if (inline === undefined) {
      index += 1;
    }
    if (value === undefined || value === "") {
      return `${name} needs a value`;
    }
    if (name === "--url") {
      parsed.url = value;
    } else {
      parsed.dir = value;
    }
  }
  return parsed;
};

/** Turns a command line into a config. A usage problem comes back as its message. */
const configure = (options: TransferOptions): Config | string => {
  const parsed = splitArgs(options.argv);
  if (typeof parsed === "string") {
    return parsed;
  }
  const [command, ...rest] = parsed.words;
  if (command === undefined) {
    return USAGE;
  }
  if (command !== "pull" && command !== "push") {
    return `unknown command ${command}. ${USAGE}`;
  }

  const origin = (
    parsed.url ??
    nonEmpty(options.env.HM_LIBRARY_URL) ??
    ""
  ).replace(TRAILING_SLASHES, "");
  if (origin === "") {
    return "--url or HM_LIBRARY_URL is required";
  }
  if (!isUrl(origin)) {
    return "the library URL is not a valid URL";
  }
  const token = nonEmpty(options.env.HM_LIBRARY_TOKEN);
  if (token === undefined) {
    return "HM_LIBRARY_TOKEN is required";
  }

  const dir = resolve(
    parsed.dir ?? nonEmpty(options.env.HM_LIBRARY_DIR) ?? DEFAULT_DIR
  );
  const name = basename(dir);
  if (name === "") {
    return "the working copy must be a folder, not the root";
  }

  const paths: string[] = [];
  for (const word of rest) {
    const path = word.replace(EDGE_SLASHES, "");
    if (
      path === "" ||
      path.split("/").some((segment) => segment === "" || segment === "..")
    ) {
      return `bad path ${word}`;
    }
    paths.push(path);
  }
  if (command === "pull" && paths.length === 0) {
    return "pull needs at least one path";
  }

  return {
    base: `${origin}${LIBRARY_ROUTE}`,
    command,
    dir,
    manifest: join(dirname(dir), `${name}.manifest.json`),
    paths,
    token,
  };
};

const pull = async (
  sync: LibrarySync,
  paths: readonly string[],
  say: (line: string) => void
): Promise<number> => {
  const result = await sync.syncIn({ roots: paths.map(writeRoot) });
  say(
    `pulled ${result.pulled.length}, removed ${result.removed.length}, kept ${result.kept.length} for local edits, skipped ${result.skipped.length} over 10 MB, failed ${result.failed.length}`
  );
  for (const failure of result.failed) {
    say(`failed ${failure.path}: ${failure.message}`);
  }
  for (const path of result.kept) {
    say(`kept ${path} (local edits not sent)`);
  }
  for (const path of result.conflicts) {
    say(`conflict copy waiting: ${path}`);
  }
  return result.failed.length === 0 ? EXIT_OK : EXIT_FAILED;
};

const push = async (
  sync: LibrarySync,
  remote: FetchRemote,
  local: LocalPort,
  manifest: ManifestStore,
  config: Config,
  say: (line: string) => void
): Promise<number> => {
  // With no path, everything pulled earlier or present now: a top-level
  // folder deleted here still has manifest entries, so its deletes go out.
  const top = (path: string) => path.split("/")[0] ?? path;
  const roots =
    config.paths.length > 0
      ? config.paths.map(writeRoot)
      : [
          ...new Set([
            ...(await local.list("")).map((entry) => entry.name),
            ...(await manifest.load()).map((entry) => top(entry.path)),
          ]),
        ].map(writeRoot);
  if (roots.length === 0) {
    say(`nothing to push: ${config.dir} has no files or folders`);
    return EXIT_OK;
  }

  // The library names conflict copies after the run, so the run id comes first.
  const runId = await remote.runId();
  const result = await sync.syncOut({ roots, runId });
  for (const conflict of result.conflicts) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one record at a time keeps the log lines in order
      await remote.recordConflict(conflict);
    } catch (error) {
      say(
        `warning: recording the conflict for ${conflict.path} failed: ${messageOf(error)}`
      );
    }
  }

  say(
    `written ${result.written.length}, deleted ${result.deleted.length}, conflicts ${result.conflicts.length}, skipped ${result.skipped.length} over 10 MB, refused ${result.refused.length}, failed ${result.failed.length}`
  );
  for (const path of result.written) {
    say(`wrote ${path}`);
  }
  for (const conflict of result.conflicts) {
    say(
      `conflict: ${conflict.path} changed in the library meanwhile, your copy is saved as ${conflict.conflictPath}`
    );
  }
  for (const path of result.refused) {
    say(`refused ${path} (read-only in the library)`);
  }
  for (const path of result.deleted) {
    say(`deleted ${path}`);
  }
  for (const path of result.deleteSkipped) {
    say(`delete skipped ${path} (changed in the library meanwhile)`);
  }
  for (const failure of result.failed) {
    say(`failed ${failure.path}: ${failure.message}`);
  }
  return result.failed.length === 0 ? EXIT_OK : EXIT_FAILED;
};

/**
 * Runs `pull` or `push` and returns the exit code: 0 for success, 1 for a
 * failed sync or a thrown error, 2 for a usage error. A token in any logged
 * line is replaced with a placeholder.
 */
export const runTransfer = async (
  options: TransferOptions
): Promise<number> => {
  const token = options.env.HM_LIBRARY_TOKEN ?? "";
  const say = (line: string): void => {
    options.log(
      token === "" ? line : line.split(token).join(TOKEN_PLACEHOLDER)
    );
  };
  try {
    const config = configure(options);
    if (typeof config === "string") {
      say(`error: ${config}`);
      return EXIT_USAGE;
    }
    const remote = createFetchRemote({
      base: config.base,
      fetch: options.fetch,
      token: config.token,
    });
    const local = createDiskLocal(config.dir);
    const manifest = createFileManifest(config.manifest);
    const sync = createLibrarySync({ local, manifest, remote });
    return config.command === "pull"
      ? await pull(sync, config.paths, say)
      : await push(sync, remote, local, manifest, config, say);
  } catch (error) {
    say(`error: ${messageOf(error)}`);
    return EXIT_FAILED;
  }
};
