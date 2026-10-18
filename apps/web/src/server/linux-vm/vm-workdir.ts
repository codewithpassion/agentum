import type { PiInput } from "../pi-run-files.ts";
import type { SkillSummary, SkillsPort } from "../pi-run-skills.ts";
import { type LinuxVm, VM_WORKDIR, VmFileError } from "./vm-port.ts";

const SKILLS_DIR = `${VM_WORKDIR}/skills`;
const INPUT_DIR = `${VM_WORKDIR}/input`;
const SKILL_FILE = "SKILL.md";
const FALLBACK_NAME = "file";
const CHMOD_TIMEOUT_MS = 30_000;
const CHMOD_OUTPUT_BYTES = 4096;
/** Tries to put a staged skills folder in place when another run's folder lands in the same moment. */
const SWAP_ATTEMPTS = 3;

export interface InputFile {
  bytes: Uint8Array;
  name: string;
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

/** Writes one skill file under `folder`. Returns its path when the port cannot read it. */
const placeSkillFile = async (
  vm: LinuxVm,
  port: SkillsPort,
  folder: string,
  path: string
): Promise<string | undefined> => {
  let bytes: Uint8Array;
  try {
    bytes = await port.read(path);
  } catch {
    return path;
  }
  const target = `${folder}/${path}`;
  await vm.mkdir(parentOf(target), { recursive: true });
  await vm.writeFile(target, bytes);
};

/** Writes a skill's SKILL.md and other files under `folder`. Returns the paths that could not be read. */
const placeSkill = async (
  vm: LinuxVm,
  port: SkillsPort,
  folder: string,
  skill: SkillSummary
): Promise<string[]> => {
  const paths = [`${skill.name}/${SKILL_FILE}`, ...skill.files];
  const results = await Promise.all(
    paths.map((path) => placeSkillFile(vm, port, folder, path))
  );
  return results.filter((path): path is string => path !== undefined);
};

const shellQuote = (text: string): string =>
  `'${text.replaceAll("'", "'\\''")}'`;

/** Sets the executable flag on the placed files under `folder` in one command. */
const markExecutable = async (
  vm: LinuxVm,
  folder: string,
  paths: readonly string[]
): Promise<void> => {
  const targets = paths
    .map((path) => shellQuote(`${folder}/${path}`))
    .join(" ");
  const result = await vm.exec({
    command: `chmod +x -- ${targets}`,
    cwd: VM_WORKDIR,
    maxOutputBytes: CHMOD_OUTPUT_BYTES,
    timeoutMs: CHMOD_TIMEOUT_MS,
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(
      `Could not set the executable flag on skill files: ${result.stderr}`
    );
  }
};

const isCode = (error: unknown, ...codes: string[]): boolean =>
  error instanceof VmFileError && codes.includes(error.code);

/** Moves the old skills back after a failed swap. False when that failed for a reason that leaves them only in `aside`. */
const putBack = async (vm: LinuxVm, aside: string): Promise<boolean> => {
  try {
    await vm.rename(aside, SKILLS_DIR);
    return true;
  } catch (error) {
    // Nothing was moved aside, or a newer run's folder is in place: there is nothing to put back.
    return isCode(error, "ENOENT", "ENOTEMPTY", "EEXIST");
  }
};

/**
 * Replaces the skills folder with `staging`. A rename onto a folder that is not
 * empty fails, so the old folder is first renamed aside, not deleted: a call
 * that reads it is cut off for the time of two renames, not of a delete. The
 * old folder is deleted after the swap, or put back when the swap fails. A run
 * that swaps in the same moment can fill the name again between the two
 * renames, so that case tries again.
 */
const swapIn = async (
  vm: LinuxVm,
  staging: string,
  aside: string
): Promise<void> => {
  let swapped = false;
  try {
    for (let attempt = 1; ; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each attempt follows the failure of the one before
      await vm.remove(aside, { force: true, recursive: true });
      try {
        await vm.rename(SKILLS_DIR, aside);
      } catch (error) {
        if (!isCode(error, "ENOENT")) {
          throw error;
        }
      }
      try {
        await vm.rename(staging, SKILLS_DIR);
        swapped = true;
        return;
      } catch (error) {
        if (!isCode(error, "ENOTEMPTY", "EEXIST") || attempt >= SWAP_ATTEMPTS) {
          throw error;
        }
      }
    }
  } finally {
    // After a failed swap the old skills go back. The aside folder stays when they cannot, so they are not lost.
    const settled = swapped || (await putBack(vm, aside));
    if (settled) {
      await vm.remove(aside, { force: true, recursive: true }).catch(() => {
        // A folder left behind is scratch, and an error here must not hide the swap's own result.
      });
    }
  }
};

/**
 * Puts the run's skills in `${VM_WORKDIR}/skills`. The files are first written
 * to a staging folder named for the run, `${VM_WORKDIR}/skills.${runId}`, and
 * that folder then replaces the skills folder by a rename. The VM is shared
 * by every session of an agent, so a run must not empty the folder that another
 * run's call is reading. The staging folder is what changes, and the swap
 * takes the old folder away, so a skill that was deleted does not stay.
 * Files that cannot be read are skipped. The folder is still put in place, and
 * then an error naming them is thrown. Files flagged as executable get the
 * executable flag in one command before the swap. If anything fails before
 * the swap, the staging folder is removed and the old skills folder stays.
 */
export const placeSkills = async (
  vm: LinuxVm,
  skills: readonly SkillSummary[],
  port: SkillsPort,
  runId: string
): Promise<void> => {
  const staging = `${VM_WORKDIR}/skills.${runId}`;
  let skipped: string[];
  try {
    await vm.remove(staging, { force: true, recursive: true });
    await vm.mkdir(staging, { recursive: true });
    skipped = (
      await Promise.all(
        skills.map((skill) => placeSkill(vm, port, staging, skill))
      )
    ).flat();
    const executable = skills.flatMap((skill) => skill.executable ?? []);
    if (skipped.length === 0 && executable.length > 0) {
      await markExecutable(vm, staging, executable);
    }
    await swapIn(vm, staging, `${VM_WORKDIR}/skills.old.${runId}`);
  } catch (error) {
    await vm.remove(staging, { force: true, recursive: true });
    throw error;
  }
  if (skipped.length > 0) {
    throw new Error(
      `Could not read skill files, so they were not placed: ${skipped.join(", ")}`
    );
  }
};

/** The last path segment with NULs removed. A name that is empty or a dot entry becomes "file". */
const safeName = (name: string): string => {
  const segment = (name.split("/").pop() ?? "").replaceAll("\0", "");
  return segment === "" || segment === "." || segment === ".."
    ? FALLBACK_NAME
    : segment;
};

/** Splits "a.txt" into "a" and ".txt". A leading dot, as in ".env", is not an extension. */
const splitExtension = (name: string): [string, string] => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
};

/** The first free name for `name`. Later ones get "-2", "-3" before the extension. */
const claimName = (used: Set<string>, name: string): string => {
  const [stem, extension] = splitExtension(name);
  let candidate = name;
  for (let copy = 2; used.has(candidate); copy += 1) {
    candidate = `${stem}-${copy}${extension}`;
  }
  used.add(candidate);
  return candidate;
};

/**
 * Writes the run's input files to `${VM_WORKDIR}/input` and returns their
 * absolute paths, in the order given. The folder is kept, so files of earlier
 * runs in the session stay. Names are made unique within one call only: a file
 * of a later run with the same name replaces the earlier one.
 */
export const placeInputFiles = async (
  vm: LinuxVm,
  files: readonly InputFile[]
): Promise<string[]> => {
  await vm.mkdir(INPUT_DIR, { recursive: true });
  const used = new Set<string>();
  const placed = files.map((file) => ({
    bytes: file.bytes,
    path: `${INPUT_DIR}/${claimName(used, safeName(file.name))}`,
  }));
  await Promise.all(placed.map(({ bytes, path }) => vm.writeFile(path, bytes)));
  return placed.map(({ path }) => path);
};

/** The message with a line saying where the attached files are in the VM, added to its first text. */
export const withPlacedPaths = (
  content: PiInput,
  paths: readonly string[]
): PiInput => {
  if (paths.length === 0) {
    return content;
  }
  const note = `\n\nThe attached files are also in the Linux VM at: ${paths.join(", ")}`;
  if (typeof content === "string") {
    return `${content}${note}`;
  }
  let noted = false;
  return content.map((block) => {
    if (noted || block.type !== "text") {
      return block;
    }
    noted = true;
    return { ...block, text: `${block.text}${note}` };
  });
};
