// How a run's files move in and out of its work directory. On a single-user
// machine the directory is the daemon's own and plain `node:fs` does it. On a
// multi-user machine hm-agent owns the directory, so every step goes through
// the narrow sudo rule of `install-service` (`dd`, `realpath`, `stat`, `head`,
// plus `mkdir` from M1.4), and the files end up owned by hm-agent. A path
// outside the work directory is refused before any sudo call that would touch
// it.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { file as bunFile } from "bun";
import {
  AGENT_DD,
  AGENT_HEAD,
  AGENT_MKDIR,
  AGENT_REALPATH,
  AGENT_STAT,
  AS_AGENT,
} from "./agent-user.ts";
import {
  isWithin,
  mimeOf,
  type OutboundFile,
  type RejectedFile,
  type ResolvedOutbound,
  resolveOutboundFiles,
} from "./attachments.ts";
import type { CommandRunner } from "./command.ts";

export interface WorkFiles {
  /** Reads a file that `resolveOutbound` returned. */
  read: (file: OutboundFile) => Promise<Blob>;
  /** Vets marker paths: each must be a regular file inside the work directory, at most `maxBytes`. */
  resolveOutbound: (
    paths: string[],
    maxBytes: number
  ) => Promise<ResolvedOutbound>;
  /** Writes `bytes` to `relPath` under the work directory, creating its folder. Throws when the path leaves the directory. */
  write: (relPath: string, bytes: Uint8Array) => Promise<void>;
}

export interface WorkFilesOptions {
  run: CommandRunner;
  singleUser: boolean;
  workDir: string;
}

// Size and raw mode in hex. `%F` would print a translated type name on a
// machine with a non-English locale, which sudo passes through.
const HEX = 16;
const STAT_FORMAT = "%s %f";
const STAT_ANSWER = /^(\d+) ([0-9a-f]+)$/;
// The file type is the top four bits of the 16-bit mode: 8 is a regular file.
const MODE_TYPE_DIVISOR = 0x10_00;
const REGULAR_FILE_TYPE = 8;

/** The absolute path of `relPath` under `workDir`; throws when it lands outside. */
export const insideWorkDir = (workDir: string, relPath: string): string => {
  const root = resolve(workDir);
  const target = resolve(root, relPath);
  if (isAbsolute(relPath) || target === root || !isWithin(root, target)) {
    throw new Error(`${relPath} is not a path inside the work directory`);
  }
  return target;
};

const singleUserFiles = (workDir: string): WorkFiles => ({
  read: (file) => Promise.resolve(bunFile(file.path)),
  resolveOutbound: (paths, maxBytes) =>
    Promise.resolve(resolveOutboundFiles(paths, { maxBytes, workDir })),
  write: (relPath, bytes) =>
    Promise.resolve().then(() => {
      const target = insideWorkDir(workDir, relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }),
});

const sudoFiles = (run: CommandRunner, workDir: string): WorkFiles => {
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

  /** The real path of `path`, or null when nothing is there. */
  const realpathOf = async (path: string): Promise<string | null> => {
    const result = await run([...AS_AGENT, AGENT_REALPATH, "-e", "--", path]);
    const real = result.stdout.trim();
    return result.exitCode === 0 && real !== "" ? real : null;
  };

  let realRoot: Promise<string | null> | undefined;

  const inspect = async (
    raw: string,
    maxBytes: number
  ): Promise<{ file: OutboundFile } | { reason: RejectedFile["reason"] }> => {
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(workDir, raw);
    // Lexical check first, so a path that plainly leaves the directory costs no sudo call.
    if (!isWithin(workDir, abs)) {
      return { reason: "outside_root" };
    }
    const real = await realpathOf(abs);
    if (real === null) {
      return { reason: "missing" };
    }
    realRoot ??= realpathOf(workDir);
    const root = await realRoot;
    if (root === null || !isWithin(root, real)) {
      return { reason: "outside_root" };
    }
    const stat = await run([
      ...AS_AGENT,
      AGENT_STAT,
      "-c",
      STAT_FORMAT,
      "--",
      real,
    ]);
    const match = STAT_ANSWER.exec(stat.stdout.trim());
    if (stat.exitCode !== 0 || match === null) {
      return { reason: "missing" };
    }
    const mode = Number.parseInt(match[2] ?? "", HEX);
    if (Math.trunc(mode / MODE_TYPE_DIVISOR) !== REGULAR_FILE_TYPE) {
      return { reason: "not_a_file" };
    }
    const size = Number(match[1]);
    if (size > maxBytes) {
      return { reason: "too_large" };
    }
    return {
      file: { mime: mimeOf(real), name: basename(abs), path: real, size },
    };
  };

  return {
    read: async (file) => {
      const result = await asAgent("head", [
        AGENT_HEAD,
        "-c",
        String(file.size),
        "--",
        file.path,
      ]);
      return new Blob(
        [result.stdoutBytes ?? new TextEncoder().encode(result.stdout)],
        {
          type: file.mime,
        }
      );
    },
    resolveOutbound: async (paths, maxBytes) => {
      const files: OutboundFile[] = [];
      const rejected: RejectedFile[] = [];
      for (const raw of paths) {
        // biome-ignore lint/performance/noAwaitInLoops: one marker at a time keeps the sudo calls in order.
        const outcome = await inspect(raw, maxBytes);
        if ("file" in outcome) {
          files.push(outcome.file);
        } else {
          rejected.push({
            name: basename(raw),
            path: isAbsolute(raw) ? raw : resolve(workDir, raw),
            reason: outcome.reason,
          });
        }
      }
      return { files, rejected };
    },
    write: async (relPath, bytes) => {
      const target = insideWorkDir(workDir, relPath);
      await asAgent("mkdir", [AGENT_MKDIR, "-p", dirname(target)]);
      await asAgent("dd", [AGENT_DD, `of=${target}`, "status=none"], bytes);
    },
  };
};

export const createWorkFiles = (options: WorkFilesOptions): WorkFiles =>
  options.singleUser
    ? singleUserFiles(options.workDir)
    : sudoFiles(options.run, options.workDir);
