import { expect, test } from "bun:test";
import {
  checkGithubImport,
  compareUrl,
  hasUpdate,
  pinnedUrl,
  repoSlug,
  shortSha,
} from "./github-source-logic.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("checkGithubImport accepts a bare repository URL and defaults the ref", () => {
  expect(
    checkGithubImport({ path: "", ref: "", url: "https://github.com/o/r" })
  ).toEqual({
    ok: true,
    value: { ref: "HEAD", url: "https://github.com/o/r" },
  });
});

test("checkGithubImport keeps a path and ref", () => {
  expect(
    checkGithubImport({
      path: " skills/pdf ",
      ref: "v1.2",
      url: "https://github.com/o/r",
    })
  ).toEqual({
    ok: true,
    value: { path: "skills/pdf", ref: "v1.2", url: "https://github.com/o/r" },
  });
});

test("checkGithubImport reports each bad field on its own", () => {
  const result = checkGithubImport({
    path: "../x",
    ref: "a b",
    url: "http://example.com/o/r",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.url).toBeDefined();
    expect(result.errors.path).toBeDefined();
    expect(result.errors.ref).toBeDefined();
  }
});

test("shortSha takes the first seven characters", () => {
  expect(shortSha(SHA_A)).toBe("aaaaaaa");
});

test("repoSlug drops the host, a trailing slash and .git", () => {
  expect(repoSlug("https://github.com/o/r")).toBe("o/r");
  expect(repoSlug("https://github.com/o/r/")).toBe("o/r");
  expect(repoSlug("https://github.com/o/r.git")).toBe("o/r");
});

test("pinnedUrl links the folder at the pinned commit", () => {
  const base = { commitSha: SHA_A, repoUrl: "https://github.com/o/r" };
  expect(pinnedUrl({ ...base, path: null })).toBe(
    `https://github.com/o/r/tree/${SHA_A}`
  );
  expect(pinnedUrl({ ...base, path: "skills/pdf" })).toBe(
    `https://github.com/o/r/tree/${SHA_A}/skills/pdf`
  );
});

test("compareUrl and hasUpdate need a newer commit that differs from the pin", () => {
  const base = { commitSha: SHA_A, repoUrl: "https://github.com/o/r" };
  expect(compareUrl({ ...base, latestCommitSha: null })).toBeNull();
  expect(compareUrl({ ...base, latestCommitSha: SHA_A })).toBeNull();
  expect(hasUpdate({ commitSha: SHA_A, latestCommitSha: SHA_B })).toBe(true);
  expect(compareUrl({ ...base, latestCommitSha: SHA_B })).toBe(
    `https://github.com/o/r/compare/${SHA_A}...${SHA_B}`
  );
});
