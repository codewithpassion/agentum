import { githubSkillSourceSchema } from "@repo/protocol/skills";
import type { SkillSummary } from "#/integrations/trpc/types";

/** The GitHub source of a skill, as `skillStore.list` returns it. */
export type SkillSource = NonNullable<SkillSummary["source"]>;

export interface GithubImportFields {
  path: string;
  ref: string;
  url: string;
}

export interface GithubImportErrors {
  path?: string;
  ref?: string;
  url?: string;
}

export type GithubImportCheck =
  | { errors: GithubImportErrors; ok: false }
  | { ok: true; value: { path?: string; ref: string; url: string } };

const SHORT_SHA_LENGTH = 7;
const DEFAULT_REF = "HEAD";
const GITHUB_HOST = /^https:\/\/github\.com\//;
const LEADING_SLASHES = /^\/+/;
const TRAILING_SLASHES = /\/+$/;
const GIT_SUFFIX = /\.git$/;

/** Checks the form fields with the shared rules. An empty ref means the default branch, an empty path the repository root. */
export const checkGithubImport = (
  fields: GithubImportFields
): GithubImportCheck => {
  const path = fields.path.trim();
  const ref = fields.ref.trim();
  const parsed = githubSkillSourceSchema.safeParse({
    provider: "github",
    ref: ref === "" ? DEFAULT_REF : ref,
    repoUrl: fields.url,
    ...(path === "" ? {} : { path }),
  });
  if (parsed.success) {
    return {
      ok: true,
      value: {
        ...(parsed.data.path === undefined ? {} : { path: parsed.data.path }),
        ref: parsed.data.ref,
        url: parsed.data.repoUrl,
      },
    };
  }
  const errors: GithubImportErrors = {};
  for (const issue of parsed.error.issues) {
    const [field] = issue.path;
    if (field === "repoUrl") {
      errors.url ??= issue.message;
    } else if (field === "path" || field === "ref") {
      errors[field] ??= issue.message;
    }
  }
  return { errors, ok: false };
};

export const shortSha = (sha: string): string => sha.slice(0, SHORT_SHA_LENGTH);

/** `owner/repo` from a stored repository URL. */
export const repoSlug = (repoUrl: string): string =>
  repoUrl
    .replace(GITHUB_HOST, "")
    .replace(TRAILING_SLASHES, "")
    .replace(GIT_SUFFIX, "");

const repoBase = (repoUrl: string): string =>
  `https://github.com/${repoSlug(repoUrl)}`;

/** The skill's folder in the repository at the pinned commit. */
export const pinnedUrl = (
  source: Pick<SkillSource, "commitSha" | "path" | "repoUrl">
): string => {
  const folder = (source.path ?? "")
    .replace(LEADING_SLASHES, "")
    .replace(TRAILING_SLASHES, "");
  const base = `${repoBase(source.repoUrl)}/tree/${source.commitSha}`;
  return folder === "" ? base : `${base}/${folder}`;
};

/** True when upstream has a commit newer than the pin. */
export const hasUpdate = (
  source: Pick<SkillSource, "commitSha" | "latestCommitSha">
): boolean =>
  source.latestCommitSha !== null &&
  source.latestCommitSha !== source.commitSha;

/** GitHub's comparison of the pinned commit with the newest one seen. Null without an update. */
export const compareUrl = (
  source: Pick<SkillSource, "commitSha" | "latestCommitSha" | "repoUrl">
): string | null =>
  hasUpdate(source)
    ? `${repoBase(source.repoUrl)}/compare/${source.commitSha}...${source.latestCommitSha}`
    : null;
