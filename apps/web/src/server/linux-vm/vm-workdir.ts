import type { PiInput } from "../pi-run-files.ts";
import type { SkillSummary, SkillsPort } from "../pi-run-skills.ts";
import { type LinuxVm, VM_WORKDIR } from "./vm-port.ts";

const SKILLS_DIR = `${VM_WORKDIR}/skills`;
const INPUT_DIR = `${VM_WORKDIR}/input`;
const SKILL_FILE = "SKILL.md";
const FALLBACK_NAME = "file";

export interface InputFile {
  bytes: Uint8Array;
  name: string;
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

/** Writes one skill file. Returns its path when the port cannot read it. */
const placeSkillFile = async (
  vm: LinuxVm,
  port: SkillsPort,
  path: string
): Promise<string | undefined> => {
  let bytes: Uint8Array;
  try {
    bytes = await port.read(path);
  } catch {
    return path;
  }
  const target = `${SKILLS_DIR}/${path}`;
  await vm.mkdir(parentOf(target), { recursive: true });
  await vm.writeFile(target, bytes);
};

/** Writes a skill's SKILL.md and other files. Returns the paths that could not be read. */
const placeSkill = async (
  vm: LinuxVm,
  port: SkillsPort,
  skill: SkillSummary
): Promise<string[]> => {
  const paths = [`${skill.name}/${SKILL_FILE}`, ...skill.files];
  const results = await Promise.all(
    paths.map((path) => placeSkillFile(vm, port, path))
  );
  return results.filter((path): path is string => path !== undefined);
};

/**
 * Puts the run's skills in `${VM_WORKDIR}/skills`. The old folder goes first,
 * so a skill that was deleted does not stay in the VM. Files that cannot be
 * read are skipped, and an error naming them is thrown after the rest are placed.
 */
export const placeSkills = async (
  vm: LinuxVm,
  skills: readonly SkillSummary[],
  port: SkillsPort
): Promise<void> => {
  await vm.remove(SKILLS_DIR, { force: true, recursive: true });
  await vm.mkdir(SKILLS_DIR, { recursive: true });
  const skipped = (
    await Promise.all(skills.map((skill) => placeSkill(vm, port, skill)))
  ).flat();
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
