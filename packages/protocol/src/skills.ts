// What the Worker and the daemon agree on for an agent's skills (S.1). The
// daemon asks `GET /api/runs/:id/skills` for the file list, then fetches each
// file with `GET /api/runs/:id/skills/file?path=`. A path is relative to
// `.claude/skills/` and starts with the skill's folder: `shout/SKILL.md`.

import { z } from "zod";

/** Most files one agent's skills may hold. */
export const SKILLS_MAX_FILES = 200;

/** Most bytes, over all files, one agent's skills may hold: 5 MB. */
export const SKILLS_MAX_BYTES = 5 * 1024 * 1024;

export const skillFileSchema = z.strictObject({
  etag: z.string(),
  path: z.string().min(1),
  size: z.int().nonnegative(),
});
export type SkillFile = z.infer<typeof skillFileSchema>;

export const skillsListResponseSchema = z.strictObject({
  files: z.array(skillFileSchema),
});
export type SkillsListResponse = z.infer<typeof skillsListResponseSchema>;

// Adapted from trueforge, MIT licence
// (packages/trueforge/src/schemas/skill.ts). GitHub only here.
const GITHUB_URL_REGEX =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/|\.git)?$/;
const GIT_REF_REGEX = /^[A-Za-z0-9._\-/]+$/;
const SKILL_PATH_REGEX = /^[A-Za-z0-9._\-/]+$/;
const hasParentTraversal = (value: string): boolean =>
  value.split("/").includes("..");

/** Full HTTPS URL of a GitHub repository, `https://github.com/<owner>/<repo>`. */
export const skillGitUrlSchema = z
  .string()
  .trim()
  .min(1)
  .regex(GITHUB_URL_REGEX, "Must be a GitHub HTTPS URL")
  .refine((v) => !hasParentTraversal(v), 'URL must not contain ".." segments')
  .describe("Full HTTPS URL of a GitHub repository.");

/** Path to the skill directory in the repository. Omit to use the repository root. */
export const skillGitPathSchema = z
  .string()
  .trim()
  .min(1)
  .regex(
    SKILL_PATH_REGEX,
    'Path may only contain letters, numbers, ".", "_", "-", and "/"'
  )
  .refine((v) => !hasParentTraversal(v), 'Path must not contain ".." segments')
  .refine(
    (v) => !v.split("/").includes("."),
    'Path must not contain "." segments'
  )
  .refine(
    (v) => v.replace(/^\/+|\/+$/g, "").length > 0,
    "Path must reference a subdirectory, not only slashes"
  )
  .describe(
    "Path to the skill directory within the repository. Omit to use the repository root."
  );

/** Git ref: branch name, tag, or commit SHA. */
export const skillGitRefSchema = z
  .string()
  .trim()
  .min(1)
  .regex(
    GIT_REF_REGEX,
    'Ref may only contain letters, numbers, ".", "_", "-", and "/"'
  )
  .refine((v) => !hasParentTraversal(v), 'Ref must not contain ".." segments')
  .refine(
    (v) => v.replace(/^\/+|\/+$/g, "").length > 0,
    "Ref must not consist only of slashes"
  )
  .describe("Git ref: branch name, tag, or commit SHA.");

/** A skill read from a GitHub repository. */
export const githubSkillSourceSchema = z.strictObject({
  path: skillGitPathSchema.optional(),
  provider: z.literal("github"),
  ref: skillGitRefSchema,
  repoUrl: skillGitUrlSchema,
});
export type GithubSkillSource = z.infer<typeof githubSkillSourceSchema>;

/** One file fetched from a skill's tree. */
export interface FetchedSkillFile {
  bytes: Uint8Array;
  executable: boolean;
  path: string;
}

/** The files of a skill at one commit. */
export interface FetchedSkillTree {
  commitSha: string;
  files: FetchedSkillFile[];
}

/**
 * Port for reading a GitHub skill. Shared by the importer (V7.9) and the
 * update tick (V7.10). The adapter that calls GitHub lives in services.
 */
export interface GithubSkillFetcher {
  /** Lists the files under `path` (or the repo root) at `commitSha`. */
  fetchTree: (
    repoUrl: string,
    commitSha: string,
    path: string | undefined,
    token?: string
  ) => Promise<FetchedSkillTree>;
  /** Resolves a branch, tag or SHA to a full commit SHA. */
  resolveCommit: (
    repoUrl: string,
    ref: string,
    token?: string
  ) => Promise<string>;
}
