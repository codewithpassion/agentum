// How a run's input files get into its work directory. On a single-user
// machine the directory is the daemon's own and plain `node:fs` writes to it.
// On a multi-user machine hm-agent owns the directory, so each write goes
// through the narrow sudo rule of `install-service` (`mkdir` and `dd`), and the
// file ends up owned by hm-agent. A path outside the work directory is refused
// before any sudo call that would touch it.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { AGENT_DD, AGENT_MKDIR, AS_AGENT } from "./agent-user.ts";
import type { CommandRunner } from "./command.ts";

export interface WorkFiles {
  /** Writes `bytes` to `relPath` under the work directory, creating its folder. Throws when the path leaves the directory. */
  write: (relPath: string, bytes: Uint8Array) => Promise<void>;
}

export interface WorkFilesOptions {
  run: CommandRunner;
  singleUser: boolean;
  workDir: string;
}

const isWithin = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
};

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

  return {
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
