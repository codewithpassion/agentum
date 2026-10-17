/**
 * Runs a skill script in the session's Linux VM with bun. The script's files
 * go into the workdir's skills folder first (a refresh of what the run start
 * placed there), and the script runs with the workdir as its working folder, so
 * it can read and write the session's files. Besides a minimal PATH, the
 * command sees only the variables in `input.env`.
 * `input.proxy` needs no action here: the platform routes the VM's HTTPS
 * requests through the proxy for the whole session, so the script never sees
 * a proxy secret. Output is masked by the caller, not here. A VM that fails
 * rejects the run, which the caller reports as a failed sandbox.
 */

import {
  type SandboxRunInput,
  type SandboxRunResult,
  type SkillScriptSandbox,
  TIMEOUT_EXIT_CODE,
} from "../skill-scripts/sandbox-port.ts";
import { type LinuxVm, VM_WORKDIR } from "./vm-port.ts";

const SKILLS_FOLDER = `${VM_WORKDIR}/skills`;

/** Quotes one argument for the shell. A single quote closes the quoting, adds an escaped quote, and reopens it. */
const shellQuote = (text: string): string =>
  `'${text.replaceAll("'", "'\\''")}'`;

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

const placeFiles = async (
  vm: LinuxVm,
  folder: string,
  files: SandboxRunInput["files"]
): Promise<void> => {
  await Promise.all(
    files.map(async (file) => {
      const path = `${folder}/${file.path}`;
      await vm.mkdir(parentOf(path), { recursive: true });
      await vm.writeFile(path, file.bytes);
    })
  );
};

const commandFor = (input: SandboxRunInput, entryPath: string): string =>
  ["bun", shellQuote(entryPath), ...input.args.map(shellQuote)].join(" ");

export const vmSkillSandbox = (vm: LinuxVm): SkillScriptSandbox => ({
  run: async (input: SandboxRunInput): Promise<SandboxRunResult> => {
    const folder = `${SKILLS_FOLDER}/${input.skill}`;
    await placeFiles(vm, folder, input.files);
    const result = await vm.exec({
      command: commandFor(input, `${folder}/${input.entry}`),
      cwd: VM_WORKDIR,
      ...(input.env !== undefined && Object.keys(input.env).length > 0
        ? { env: input.env }
        : {}),
      maxOutputBytes: input.maxOutputBytes,
      timeoutMs: input.timeoutMs,
    });
    if (!result.timedOut) {
      return {
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    }
    const note = `timed out after ${input.timeoutMs / 1000} s`;
    return {
      exitCode: TIMEOUT_EXIT_CODE,
      stderr: result.stderr === "" ? note : `${note}\n${result.stderr}`,
      stdout: result.stdout,
    };
  },
});
