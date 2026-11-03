// The daemon's view of an agent's work directory, which the library sync
// keeps a copy in. It works like `work-files.ts`: on a single-user machine
// plain `node:fs` does the job, and on a multi-user machine every step runs as
// hm-agent through `sudo -n -u hm-agent`. Links and anything else that is not
// a file or a folder are never reported as either.

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  AGENT_DD,
  AGENT_FIND,
  AGENT_MKDIR,
  AGENT_RM,
  AGENT_STAT,
  AS_AGENT,
} from "./agent-user.ts";
import type { CommandRunner } from "./command.ts";
import { insideWorkDir } from "./work-files.ts";

export interface WorkDisk {
  /** Entries directly in a folder. A folder that is not there lists as empty. Links and anything that is not a file or folder are left out. */
  list: (rel: string) => Promise<{ kind: "dir" | "file"; name: string }[]>;
  read: (rel: string) => Promise<Uint8Array>;
  /** Removes a file. A path that is not there is not an error. */
  remove: (rel: string) => Promise<void>;
  /** The entry at a path, or null when there is none. A link is reported as null. */
  stat: (rel: string) => Promise<{ kind: "dir" | "file"; size: number } | null>;
  /** Writes the file and makes the folders above it. */
  write: (rel: string, bytes: Uint8Array) => Promise<void>;
}

export interface WorkDiskOptions {
  run: CommandRunner;
  singleUser: boolean;
  workDir: string;
}

type Kind = "dir" | "file";

// Size and raw mode in hex. `%F` would print a translated type name on a
// machine with a non-English locale, which sudo passes through.
const HEX = 16;
const STAT_FORMAT = "%s %f";
const STAT_ANSWER = /^(\d+) ([0-9a-f]+)$/;
// The file type is the top four bits of the 16-bit mode: 8 is a regular file
// and 4 is a folder. Anything else, such as 10 for a link, is left out.
const MODE_TYPE_DIVISOR = 0x10_00;
const REGULAR_FILE_TYPE = 8;
const FOLDER_TYPE = 4;
// `find` reads this format: `\t` and `\0` are escapes that find expands.
const LIST_FORMAT = "%y\\t%f\\0";
const RECORD_END = "\0";
const NAME_START = "\t";
const FIND_KINDS = new Map<string, Kind>([
  ["d", "dir"],
  ["f", "file"],
]);
const MISSING_ERRORS = new Set(["ENOENT", "ENOTDIR"]);
const MISSING_STDERR = ["No such file or directory", "Not a directory"];
// What `sudo -n` says when the rule does not allow the command, for example a
// machine whose install-service has not been run since `find` was added.
const SUDO_REFUSED_STDERR = [
  "a password is required",
  "is not allowed to execute",
  "may not run sudo",
];

const isMissingError = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  MISSING_ERRORS.has(String(error.code));

const isMissingStderr = (stderr: string): boolean =>
  MISSING_STDERR.some((message) => stderr.includes(message));

const kindOf = (entry: Pick<Stats, "isFile" | "isDirectory">): Kind | null => {
  if (entry.isFile()) {
    return "file";
  }
  return entry.isDirectory() ? "dir" : null;
};

/** The entry at `path` without following a link, or null when there is none. */
const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissingError(error)) {
      return null;
    }
    throw error;
  }
};

// Each method runs inside `Promise.resolve().then`, so a refused path or a
// failed call rejects the promise, the same as the sudo side.
const singleUserDisk = (workDir: string): WorkDisk => ({
  list: (rel) =>
    Promise.resolve().then(() => {
      const abs = insideWorkDir(workDir, rel);
      const folder = lstatOrNull(abs);
      if (folder === null || !folder.isDirectory()) {
        return [];
      }
      return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
        const kind = kindOf(entry);
        return kind === null ? [] : [{ kind, name: entry.name }];
      });
    }),
  read: (rel) =>
    Promise.resolve().then(() => readFileSync(insideWorkDir(workDir, rel))),
  remove: (rel) =>
    Promise.resolve().then(() => {
      try {
        rmSync(insideWorkDir(workDir, rel), { force: true });
      } catch (error) {
        if (!isMissingError(error)) {
          throw error;
        }
      }
    }),
  stat: (rel) =>
    Promise.resolve().then(() => {
      const entry = lstatOrNull(insideWorkDir(workDir, rel));
      if (entry === null) {
        return null;
      }
      const kind = kindOf(entry);
      return kind === null ? null : { kind, size: entry.size };
    }),
  write: (rel, bytes) =>
    Promise.resolve().then(() => {
      const abs = insideWorkDir(workDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    }),
});

/** Reads `find -printf` records: each is `<type char>\t<name>` and ends in a NUL. */
const parseFindOutput = (output: string): { kind: Kind; name: string }[] =>
  output.split(RECORD_END).flatMap((record) => {
    const split = record.indexOf(NAME_START);
    if (split === -1) {
      return [];
    }
    const kind = FIND_KINDS.get(record.slice(0, split));
    return kind === undefined
      ? []
      : [{ kind, name: record.slice(split + NAME_START.length) }];
  });

/** The kind named by `stat -c "%s %f"`'s answer, or null for anything else. */
const parseStatAnswer = (
  answer: string
): { kind: Kind; size: number } | null => {
  const match = STAT_ANSWER.exec(answer);
  if (match === null) {
    throw new Error(`stat failed: unexpected answer "${answer}"`);
  }
  const type = Math.trunc(
    Number.parseInt(match[2] ?? "", HEX) / MODE_TYPE_DIVISOR
  );
  if (type === REGULAR_FILE_TYPE) {
    return { kind: "file", size: Number(match[1]) };
  }
  return type === FOLDER_TYPE ? { kind: "dir", size: Number(match[1]) } : null;
};

const sudoDisk = (run: CommandRunner, workDir: string): WorkDisk => {
  const asAgent = async (
    step: string,
    command: string[],
    stdin?: Uint8Array
  ) => {
    const result = await run([...AS_AGENT, ...command], stdin);
    if (result.exitCode !== 0) {
      throw new Error(`${step} failed: ${result.stderr.trim()}`);
    }
    return result;
  };

  return {
    list: async (rel) => {
      const abs = insideWorkDir(workDir, rel);
      const result = await run([
        ...AS_AGENT,
        AGENT_FIND,
        abs,
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "-printf",
        LIST_FORMAT,
      ]);
      if (result.exitCode !== 0) {
        if (isMissingStderr(result.stderr)) {
          return [];
        }
        if (SUDO_REFUSED_STDERR.some((text) => result.stderr.includes(text))) {
          throw new Error(
            "sudo refused find as hm-agent: run agentum install-service again to allow it"
          );
        }
        throw new Error(`find failed: ${result.stderr.trim()}`);
      }
      return parseFindOutput(result.stdout);
    },
    read: async (rel) => {
      const abs = insideWorkDir(workDir, rel);
      const result = await asAgent("dd", [
        AGENT_DD,
        `if=${abs}`,
        "status=none",
      ]);
      return result.stdoutBytes ?? new TextEncoder().encode(result.stdout);
    },
    remove: async (rel) => {
      const abs = insideWorkDir(workDir, rel);
      const result = await run([...AS_AGENT, AGENT_RM, "-f", "--", abs]);
      if (result.exitCode !== 0 && !isMissingStderr(result.stderr)) {
        throw new Error(`rm failed: ${result.stderr.trim()}`);
      }
    },
    stat: async (rel) => {
      const abs = insideWorkDir(workDir, rel);
      const result = await run([
        ...AS_AGENT,
        AGENT_STAT,
        "-c",
        STAT_FORMAT,
        "--",
        abs,
      ]);
      if (result.exitCode !== 0) {
        if (isMissingStderr(result.stderr)) {
          return null;
        }
        throw new Error(`stat failed: ${result.stderr.trim()}`);
      }
      return parseStatAnswer(result.stdout.trim());
    },
    write: async (rel, bytes) => {
      const abs = insideWorkDir(workDir, rel);
      await asAgent("mkdir", [AGENT_MKDIR, "-p", dirname(abs)]);
      await asAgent("dd", [AGENT_DD, `of=${abs}`, "status=none"], bytes);
    },
  };
};

export const createWorkDisk = (options: WorkDiskOptions): WorkDisk =>
  options.singleUser
    ? singleUserDisk(options.workDir)
    : sudoDisk(options.run, options.workDir);
