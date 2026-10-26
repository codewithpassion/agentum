import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import type { GithubSkillFetcher } from "@repo/protocol/skills";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { composeWith } from "./compose.ts";

const SHA = "a".repeat(40);
const TOKEN = "ghp_test";
const SKILL_MD = "---\nname: shout\ndescription: Shouts.\n---\n\n# shout\n";

const setup = (githubToken?: string) => {
  const calls: unknown[][] = [];
  const github: GithubSkillFetcher = {
    fetchTree: (...args) => {
      calls.push(["fetchTree", ...args]);
      return Promise.resolve({
        commitSha: SHA,
        files: [
          {
            bytes: new TextEncoder().encode(SKILL_MD),
            executable: false,
            path: "SKILL.md",
          },
        ],
      });
    },
    resolveCommit: (...args) => {
      calls.push(["resolveCommit", ...args]);
      return Promise.resolve(SHA);
    },
  };
  const db = migrated();
  const composed = composeWith({
    allowedOrgIds: ["org_a"],
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: () => Promise.resolve(null),
        put: () => Promise.resolve(),
      },
      clock: systemClock,
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      github,
      githubToken,
      relay: noopRelay,
    },
  });
  return { calls, composed };
};

test("the skills store reaches the GitHub fetcher through resolveCommit and fetchTree, with the token", async () => {
  const { calls, composed } = setup(TOKEN);
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("org_a must be allowed");
  }
  const result = await composed.services.skillsStore.importGithub(
    {
      kind: "user",
      userId: "user_a",
      via: "session",
      workspaceId: workspace.id,
    },
    {
      path: "skills/shout",
      ref: "main",
      url: "https://github.com/example/repo",
    }
  );
  expect(result.created).toBe(true);
  expect(calls).toEqual([
    ["resolveCommit", "https://github.com/example/repo", "main", TOKEN],
    [
      "fetchTree",
      "https://github.com/example/repo",
      SHA,
      "skills/shout",
      TOKEN,
    ],
  ]);
});
