import type { skillSources, skillVersions } from "@repo/db/schema/skills";
import type { SkillAuthorKind, SkillVersionStatus } from "@repo/db/shared";
import { z } from "zod";

export const MESSAGE_MAX = 500;

const id = z.string().min(1).max(200);
const versionNumber = z.int().min(1);
const message = z.string().trim().min(1).max(MESSAGE_MAX);

const write = z.strictObject({
  /** Text is stored as UTF-8. */
  content: z.union([z.string(), z.instanceof(Uint8Array)]),
  /** Left out, a new file is not executable and an existing one keeps its flag. */
  executable: z.boolean().optional(),
  path: z.string(),
});
export type FileWrite = z.input<typeof write>;

const writes = z.array(write);

export const createInputSchema = z.strictObject({
  files: writes.min(1),
  message,
  name: z.string(),
});
export type CreateInput = z.input<typeof createInputSchema>;

export const commitInputSchema = z.strictObject({
  baseVersion: versionNumber,
  deletes: z.array(z.strictObject({ path: z.string() })).default([]),
  message,
  skillId: id,
  writes: writes.default([]),
});
export type CommitInput = z.input<typeof commitInputSchema>;

export const skillRefSchema = z.strictObject({ skillId: id });

export const versionRefSchema = z.strictObject({
  skillId: id,
  version: versionNumber,
  withContents: z.boolean().default(false),
});
export type VersionRefInput = z.input<typeof versionRefSchema>;

export const diffInputSchema = z.strictObject({
  from: versionNumber,
  skillId: id,
  to: versionNumber,
});
export type DiffInput = z.input<typeof diffInputSchema>;

export const revertInputSchema = z.strictObject({
  message: message.optional(),
  skillId: id,
  toVersion: versionNumber,
});
export type RevertInput = z.input<typeof revertInputSchema>;

export const decideInputSchema = z.strictObject({
  skillId: id,
  version: versionNumber,
});
export type DecideInput = z.input<typeof decideInputSchema>;

export const assignInputSchema = z.strictObject({
  agentId: id,
  skillId: id,
});
export type AssignInput = z.input<typeof assignInputSchema>;

export const pinInputSchema = z.strictObject({
  agentId: id,
  skillId: id,
  /** Null follows the latest approved version again. */
  version: versionNumber.nullable(),
});
export type PinInput = z.input<typeof pinInputSchema>;

export const forAgentOptionsSchema = z.strictObject({
  /** Only these files, each as `<skill name>/<path>`. Skills with none of them are left out. */
  paths: z.array(z.string()).optional(),
  withContents: z.boolean().default(false),
});
export type ForAgentOptions = z.input<typeof forAgentOptionsSchema>;

export const exportInputSchema = z.strictObject({
  skillId: id,
  version: versionNumber,
});
export type ExportInput = z.input<typeof exportInputSchema>;

export interface SkillRecord {
  createdAt: string;
  id: string;
  latestApprovedVersion: number | null;
  /** The newest version that is not rejected, as far as the caller may see it. */
  latestVersion: number | null;
  name: string;
  /** Null: owned by people. */
  ownerAgentId: string | null;
  source?: typeof skillSources.$inferSelect | null;
  updatedAt: string;
}

export interface VersionRecord {
  approvedAt: string | null;
  approvedBy: string | null;
  author: { id: string; kind: SkillAuthorKind; runId: string | null };
  createdAt: string;
  id: string;
  message: string;
  number: number;
  /** The version this one was made on, null for version 1. */
  parent: number | null;
  skillId: string;
  status: SkillVersionStatus;
}

export interface FileRecord {
  /** Only when contents were asked for. */
  content?: Uint8Array;
  executable: boolean;
  hash: string;
  path: string;
  size: number;
}

export interface ShownVersion {
  files: FileRecord[];
  source?: typeof skillSources.$inferSelect | null;
  version: VersionRecord;
}

export interface DiffResult {
  added: string[];
  changed: string[];
  /** A unified diff for each added, removed or changed text file. Binary files are only listed. */
  patches: { patch: string; path: string }[];
  removed: string[];
}

export interface ResolvedSkill {
  files: FileRecord[];
  name: string;
  /** True when the assignment is pinned to `version`. */
  pinned: boolean;
  skillId: string;
  version: number;
}

export interface AssignmentRecord {
  agentId: string;
  /** Null follows the latest approved version. */
  pinnedVersion: number | null;
  skillId: string;
}

export interface MigrationResult {
  /** Skills moved into the store by this call. Zero when the workspace was migrated before. */
  migrated: number;
  /** Library folders that broke a rule and were left out. */
  skipped: { path: string; reason: string }[];
}

type VersionRow = typeof skillVersions.$inferSelect;

export const toVersionRecord = (row: VersionRow): VersionRecord => ({
  approvedAt: row.approvedAt,
  approvedBy: row.approvedBy,
  author: { id: row.authorId, kind: row.authorKind, runId: row.authorRunId },
  createdAt: row.createdAt,
  id: row.id,
  message: row.message,
  number: row.number,
  parent: row.parentNumber,
  skillId: row.skillId,
  status: row.status,
});
