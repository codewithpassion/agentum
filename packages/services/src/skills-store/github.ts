import { SKILLS_MAX_BYTES, SKILLS_MAX_FILES } from "@repo/protocol/skills";
import { z } from "zod";
import { ServiceError } from "../errors.ts";
import { assertSafePath } from "./paths.ts";

const TRAILING_SLASH = /\/$/;
const GIT_SUFFIX = /\.git$/;
const REPO_SEGMENT = /^[\w.-]+$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;

export const importGithubInputSchema = z.strictObject({
  path: z.string().nullable().optional(),
  ref: z.string().trim().min(1).max(200).default("HEAD"),
  url: z.string().url(),
});
export type ImportGithubInput = z.input<typeof importGithubInputSchema>;
export interface GithubRepo {
  repoUrl: string;
}
export interface GithubSkillFile {
  bytes: Uint8Array;
  executable: boolean;
  path: string;
}
export interface GithubSkillFetcher {
  resolve: (
    input: GithubRepo & { ref: string; githubToken?: string }
  ) => Promise<string>;
  tree: (
    input: GithubRepo & {
      commitSha: string;
      path: string | null;
      githubToken?: string;
    }
  ) => Promise<GithubSkillFile[]>;
}

export const githubLocation = (input: ImportGithubInput) => {
  const parsed = importGithubInputSchema.parse(input);
  const url = new URL(parsed.url);
  // URL identifies the repository; path and ref are explicit, avoiding ambiguous branch names containing slashes.
  const parts = url.pathname
    .replace(TRAILING_SLASH, "")
    .replace(GIT_SUFFIX, "")
    .split("/")
    .slice(1);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.length !== 2 ||
    parts.some((p) => !REPO_SEGMENT.test(p) || p === "." || p === "..")
  ) {
    throw new ServiceError(
      "invalid",
      "Use a GitHub repository URL with a separate path and ref"
    );
  }
  const path = parsed.path || null;
  if (path) {
    assertSafePath(path);
  }
  return {
    name: path?.split("/").at(-1) ?? parts[1] ?? "",
    path,
    ref: parsed.ref,
    repoUrl: `https://github.com/${parts.join("/")}`,
  };
};

export const hasGithubUpdate = (
  pinned: string,
  seen: string | null,
  resolved: string
) => resolved !== pinned && resolved !== seen;

/** Public repositories work without a token. Two API requests plus one raw request per selected file. */
export const createGithubSkillFetcher = (): GithubSkillFetcher => {
  const request = async (url: string, token?: string) => {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Agentum",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: "error",
    });
    if (
      response.status === 429 ||
      (response.status === 403 &&
        response.headers.get("x-ratelimit-remaining") === "0")
    ) {
      throw new ServiceError(
        "invalid",
        "GitHub rate limit exceeded; try again after the limit resets"
      );
    }
    if (response.status === 404) {
      throw new ServiceError(
        "not_found",
        "GitHub repository, ref or skill file not found"
      );
    }
    if (!response.ok) {
      throw new ServiceError(
        "invalid",
        `GitHub request failed (${response.status})`
      );
    }
    return response;
  };
  const repository = (repoUrl: string) => new URL(repoUrl).pathname;
  return {
    async resolve({ repoUrl, ref, githubToken }) {
      const response = await request(
        `https://api.github.com/repos${repository(repoUrl)}/commits/${encodeURIComponent(ref)}`,
        githubToken
      );
      const result = (await response.json()) as { sha: string };
      if (!COMMIT_SHA.test(result.sha)) {
        throw new ServiceError("invalid", "GitHub returned an invalid commit");
      }
      return result.sha;
    },
    async tree({ repoUrl, commitSha, path, githubToken }) {
      const response = await request(
        `https://api.github.com/repos${repository(repoUrl)}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
        githubToken
      );
      const result = (await response.json()) as {
        truncated: boolean;
        tree: { path: string; type: string; mode: string; size?: number }[];
      };
      if (result.truncated) {
        throw new ServiceError(
          "invalid",
          "GitHub repository tree is too large to import safely"
        );
      }
      const prefix = path ? `${path}/` : "";
      const entries = result.tree.filter(
        (file) => file.type !== "tree" && file.path.startsWith(prefix)
      );
      if (
        entries.length > SKILLS_MAX_FILES ||
        entries.reduce((sum, file) => sum + (file.size ?? 0), 0) >
          SKILLS_MAX_BYTES
      ) {
        throw new ServiceError(
          "invalid",
          "GitHub skill exceeds the file or byte limit"
        );
      }
      let total = 0;
      const files: GithubSkillFile[] = [];
      for (const entry of entries) {
        const relative = entry.path.slice(prefix.length);
        assertSafePath(relative);
        if (
          entry.type !== "blob" ||
          !["100644", "100755"].includes(entry.mode)
        ) {
          throw new ServiceError(
            "invalid",
            "GitHub skills cannot contain symlinks or submodules"
          );
        }
        // biome-ignore lint/performance/noAwaitInLoops: Bound upstream requests and stop at the byte cap.
        const raw = await request(
          `https://raw.githubusercontent.com${repository(repoUrl)}/${encodeURIComponent(commitSha)}/${entry.path.split("/").map(encodeURIComponent).join("/")}`,
          githubToken
        );
        const bytes = new Uint8Array(await raw.arrayBuffer());
        total += bytes.byteLength;
        if (total > SKILLS_MAX_BYTES) {
          throw new ServiceError(
            "invalid",
            "GitHub skill exceeds the byte limit"
          );
        }
        files.push({
          bytes,
          executable: entry.mode === "100755",
          path: relative,
        });
      }
      return files;
    },
  };
};
