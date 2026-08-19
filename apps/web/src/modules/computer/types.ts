/** The shapes the agent computer speaks in, shared by the DO and its client. */

export const EXEC_UNAVAILABLE =
  "Command execution is unavailable in this deployment. Your files still work: read, write, edit and list them instead.";

export interface DirEntry {
  directory: boolean;
  name: string;
  size: number;
}

export type ReadResult =
  | { ok: true; content: string; size: number }
  | { ok: false; reason: string };

export type WriteResult =
  | { ok: true; created: boolean; size: number }
  | { ok: false; reason: string };

export type ListResult =
  | { ok: true; entries: DirEntry[] }
  | { ok: false; reason: string };

export type ExecResult =
  | { ok: true; exitCode: number; stderr: string; stdout: string }
  | { ok: false; reason: string };
