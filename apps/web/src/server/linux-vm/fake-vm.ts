/**
 * An in-memory `LinuxVm` for tests: a map of files and folders, and a `exec`
 * that records each call and answers with what the test says. Not shipped.
 */
import {
  type LinuxVm,
  VM_WORKDIR,
  type VmEgress,
  type VmEntry,
  type VmExecInput,
  type VmExecResult,
  VmFileError,
  type VmStat,
} from "./vm-port.ts";

export interface FakeVm extends LinuxVm {
  /** Every `setEgress` call, in order. */
  egressCalls: VmEgress[];
  /** Every `exec` call, in order. */
  execCalls: VmExecInput[];
  /** Files by absolute path. */
  files: Map<string, Uint8Array>;
  /** Folders, absolute, the root and the workdir included. */
  folders: Set<string>;
  /** What the next `exec` calls answer. The default is exit 0 with no output. */
  onExec: (input: VmExecInput) => VmExecResult | Promise<VmExecResult>;
}

const ENCODER = new TextEncoder();

export const parentOf = (path: string): string =>
  path.slice(0, path.lastIndexOf("/")) || "/";

export const textOf = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

export const createFakeVm = (): FakeVm => {
  const folders = new Set<string>(["/", VM_WORKDIR]);
  const files = new Map<string, Uint8Array>();
  const execCalls: VmExecInput[] = [];
  const egressCalls: VmEgress[] = [];
  const missing = (path: string) =>
    new VmFileError("ENOENT", `ENOENT: no such file or directory, '${path}'`);
  const childrenOf = (path: string): VmEntry[] => {
    const prefix = path === "/" ? "/" : `${path}/`;
    const entries = new Map<string, VmEntry>();
    for (const folder of folders) {
      if (
        folder !== path &&
        folder.startsWith(prefix) &&
        !folder.slice(prefix.length).includes("/")
      ) {
        entries.set(folder, {
          kind: "directory",
          name: folder.slice(prefix.length),
        });
      }
    }
    for (const file of files.keys()) {
      if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) {
        entries.set(file, { kind: "file", name: file.slice(prefix.length) });
      }
    }
    return [...entries.values()];
  };
  const fake: FakeVm = {
    egressCalls,
    exec: async (input) => {
      execCalls.push(input);
      return await fake.onExec(input);
    },
    execCalls,
    files,
    folders,
    list: (path) => {
      if (files.has(path)) {
        return Promise.reject(
          new VmFileError("ENOTDIR", `ENOTDIR: not a directory, '${path}'`)
        );
      }
      if (!folders.has(path)) {
        return Promise.reject(missing(path));
      }
      return Promise.resolve(childrenOf(path));
    },
    mkdir: (path, options) => {
      if (
        files.has(path) ||
        (folders.has(path) && options?.recursive !== true)
      ) {
        return Promise.reject(
          new VmFileError("EEXIST", `EEXIST: file already exists, '${path}'`)
        );
      }
      const parent = parentOf(path);
      if (options?.recursive === true) {
        let at = path;
        while (at !== "/") {
          folders.add(at);
          at = parentOf(at);
        }
        return Promise.resolve();
      }
      if (!folders.has(parent)) {
        return Promise.reject(missing(path));
      }
      folders.add(path);
      return Promise.resolve();
    },
    onExec: () => ({
      exitCode: 0,
      stderr: "",
      stdout: "",
      timedOut: false,
      truncated: false,
    }),
    readFile: (path) => {
      const bytes = files.get(path);
      if (bytes !== undefined) {
        return Promise.resolve(bytes);
      }
      if (folders.has(path)) {
        return Promise.reject(
          new VmFileError(
            "EISDIR",
            `EISDIR: illegal operation on a directory, '${path}'`
          )
        );
      }
      return Promise.reject(missing(path));
    },
    remove: (path, options) => {
      if (files.delete(path)) {
        return Promise.resolve();
      }
      if (!folders.has(path)) {
        return options?.force === true
          ? Promise.resolve()
          : Promise.reject(missing(path));
      }
      const inside = (other: string) => other.startsWith(`${path}/`);
      const hasChildren = [...files.keys(), ...folders].some(inside);
      if (!options?.recursive) {
        return Promise.reject(
          new VmFileError("EISDIR", `EISDIR: is a directory, '${path}'`)
        );
      }
      if (hasChildren) {
        for (const file of [...files.keys()].filter(inside)) {
          files.delete(file);
        }
        for (const folder of [...folders].filter(inside)) {
          folders.delete(folder);
        }
      }
      folders.delete(path);
      return Promise.resolve();
    },
    rename: (from, to) => {
      const bytes = files.get(from);
      if (bytes === undefined) {
        return Promise.reject(missing(from));
      }
      files.delete(from);
      files.set(to, bytes);
      return Promise.resolve();
    },
    setEgress: (egress) => {
      egressCalls.push(egress);
      return Promise.resolve();
    },
    stat: (path): Promise<VmStat> => {
      const bytes = files.get(path);
      if (bytes !== undefined) {
        return Promise.resolve({
          kind: "file",
          mtimeMs: 0,
          size: bytes.byteLength,
        });
      }
      return folders.has(path)
        ? Promise.resolve({ kind: "directory", mtimeMs: 0, size: 0 })
        : Promise.reject(missing(path));
    },
    writeFile: (path, bytes) => {
      if (folders.has(path)) {
        return Promise.reject(
          new VmFileError(
            "EISDIR",
            `EISDIR: illegal operation on a directory, '${path}'`
          )
        );
      }
      if (!folders.has(parentOf(path))) {
        return Promise.reject(missing(path));
      }
      files.set(path, bytes);
      return Promise.resolve();
    },
  };
  return fake;
};

export const bytesOf = (text: string): Uint8Array => ENCODER.encode(text);
