/**
 * The Linux VM of one agent, as the cloud runner sees it. The Sandbox SDK
 * container sits behind this port, so the file tools, the skill scripts and the
 * placement of files are tested against a fake (`fake-vm.ts`).
 *
 * The VM starts on its first call and restores the agent's home folder from its
 * last snapshot. A run that used the VM snapshots the home folder when it ends
 * (`checkpoint`), and when the VM has been idle for a while it snapshots again
 * and goes to sleep. The next call starts it again. Each restore and snapshot
 * is reported as a `workspace.snapshot` event on a run.
 */

/** The VM's scratch root: skills and input files go here, and they are gone once the VM sleeps. */
export const VM_WORKDIR = "/workspace";
/** The agent's home in the VM, and the default working folder. It is the only directory that is snapshotted. */
export const VM_HOME_DIR = `${VM_WORKDIR}/home`;
/**
 * The working copy of part of the workspace library: the agent's folder
 * `agents/<slug>` and the paths its config names. It is synced when a run
 * starts and when it ends. It sits outside home on purpose, so a snapshot does
 * not keep it, and the library stays the only copy that lasts.
 */
export const VM_LIBRARY_DIR = `${VM_WORKDIR}/library`;
/** The sync manifest of the working copy, beside it and not inside it. */
export const VM_LIBRARY_MANIFEST = `${VM_WORKDIR}/library.manifest.json`;

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

/** Who the VM's outbound requests are for. Ids only: the platform reads the secrets itself. */
export interface VmEgressRun {
  agentId: string;
  runId: string;
  workspaceId: string;
}

/**
 * The hosts whose HTTPS requests the platform handles for the VM, so a `proxy`
 * secret's header is added outside the VM. A host is exact or a `*.` wildcard.
 */
export interface VmEgress {
  hosts: string[];
  run: VmEgressRun;
}

/** The payload of a `workspace.snapshot` event: one restore or one snapshot of the home folder. */
export interface WorkspaceSnapshot {
  /** Size of the home folder, from `du -sb`. 0 when it could not be measured or the restore failed. */
  bytes: number;
  error?: string;
  /** How long the restore or the snapshot took. */
  ms: number;
  ok: boolean;
  /** The home folder is over the soft cap, or its size could not be measured. Nothing is refused. */
  warning?: string;
}

/** Paths are absolute. */
export interface LinuxVm {
  /**
   * Snapshots the home folder now and leaves the VM up. Does nothing when the
   * VM is asleep. It never throws: a failed snapshot is logged, and either way
   * a `workspace.snapshot` event goes on `run`.
   */
  checkpoint: (run: VmEgressRun) => Promise<void>;
  exec: (input: VmExecInput) => Promise<VmExecResult>;
  list: (path: string) => Promise<VmEntry[]>;
  /**
   * Takes the library sync lock for `owner`, or answers false while another
   * owner holds it. Sessions of one agent share the VM, the working copy and
   * its manifest, and each session has its own Durable Object, so the VM's
   * object is the one place that can make their syncs take turns. The same
   * owner asking again renews its hold. A hold ends after `ttlMs` unless renewed, so
   * an owner that died cannot block the others for good. It is kept in storage
   * and survives a restart of the VM's object.
   */
  lockLibrary: (owner: string, ttlMs: number) => Promise<boolean>;
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
  remove: (
    path: string,
    options?: { force?: boolean; recursive?: boolean }
  ) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  /**
   * Routes the VM's HTTPS requests to `egress.hosts` through the platform's
   * outbound entrypoint for `egress.run`, and keeps doing so when the VM sleeps
   * and wakes. A call with no hosts changes nothing. No secret value is passed.
   */
  setEgress: (egress: VmEgress) => Promise<void>;
  /**
   * Names the run that is using the VM, so the `workspace.snapshot` event of a
   * restore or an idle snapshot goes on that run. It does not start the VM.
   */
  setRun: (run: VmEgressRun) => Promise<void>;
  stat: (path: string) => Promise<VmStat>;
  /** Gives the library sync lock back. Does nothing when `owner` does not hold it. */
  unlockLibrary: (owner: string) => Promise<void>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
}
