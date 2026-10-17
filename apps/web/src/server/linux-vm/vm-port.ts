/**
 * The Linux VM of one session, as the cloud runner sees it. The Sandbox SDK
 * container sits behind this port, so the file tools, the skill scripts and the
 * placement of files are tested against a fake (`fake-vm.ts`).
 *
 * The VM starts on its first call and restores the session's workdir from its
 * last snapshot. When it has been idle for a while it snapshots the workdir
 * and goes to sleep, and the next call starts it again.
 */

/** Where the session's files live in the VM. It is the directory that is snapshotted. */
export const VM_WORKDIR = "/workspace";

export interface VmExecInput {
  command: string;
  /** Defaults to the workdir. */
  cwd?: string;
  /** What the command sees besides a minimal PATH. No Harbourmaster secret ever goes here. */
  env?: Record<string, string>;
  /** Most bytes kept of each of stdout and stderr. The rest is read and dropped. */
  maxOutputBytes: number;
  /** Wall time. When it passes the command is killed and `timedOut` is true. */
  timeoutMs: number;
}

export interface VmExecResult {
  exitCode: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
  /** Output was cut at `maxOutputBytes`. */
  truncated: boolean;
}

export type VmFileKind = "directory" | "file" | "symlink";

export interface VmStat {
  kind: VmFileKind;
  mtimeMs: number;
  size: number;
}

export interface VmEntry {
  kind: VmFileKind;
  name: string;
}

export type VmErrorCode =
  | "EACCES"
  | "EEXIST"
  | "EINVAL"
  | "EISDIR"
  | "ENOENT"
  | "ENOTDIR"
  | "ENOTEMPTY"
  | "UNKNOWN";

/** A file call the VM's file system refused. Any other error from a call means the VM itself failed. */
export class VmFileError extends Error {
  readonly code: VmErrorCode;
  constructor(code: VmErrorCode, message: string) {
    super(message);
    this.name = "VmFileError";
    this.code = code;
  }
}

/** Paths are absolute. */
export interface LinuxVm {
  exec: (input: VmExecInput) => Promise<VmExecResult>;
  list: (path: string) => Promise<VmEntry[]>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
  remove: (
    path: string,
    options?: { force?: boolean; recursive?: boolean }
  ) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  stat: (path: string) => Promise<VmStat>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
}
