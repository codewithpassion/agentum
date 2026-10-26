import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { SKILLS_MAX_BYTES, SKILLS_MAX_FILES } from "@repo/protocol/skills";
import {
  createGithubSkillFetcher,
  GithubSkillSourceError,
  parseSource,
} from "./github-skill-source.ts";

const REQUEST_MESSAGE = /request failed/i;
const COMMIT_MESSAGE = /commit SHA/i;
const LIMIT_MESSAGE = /files|bytes|MiB/i;
const SKILL_MESSAGE = /SKILL\.md/;
const UNSAFE_MESSAGE = /link|path|traversal|folder/i;
const PATH_MESSAGE = /path|traversal/i;
const ARCHIVE_MESSAGE = /archive|tar|gzip/i;
const SHA_MESSAGE = /SHA/i;
const DOWNLOAD_MESSAGE = /50.*MiB|50.*MB/i;

const repo = "https://github.com/acme/skills";
const sha = "a".repeat(40);
const top = `acme-skills-${sha.slice(0, 7)}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Entry {
  content?: string | Uint8Array;
  mode?: number;
  name: string;
  prefix?: string;
  size?: number;
  type?: string;
}

/** Tiny ustar fixture writer; only tests use Node's gzip. */
const tar = (entries: Entry[]): Uint8Array => {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const content =
      typeof entry.content === "string"
        ? encoder.encode(entry.content)
        : (entry.content ?? new Uint8Array());
    const header = new Uint8Array(512);
    const field = (fieldOffset: number, value: string) =>
      header.set(encoder.encode(value), fieldOffset);
    field(0, entry.name);
    field(100, `${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`);
    field(
      124,
      `${(entry.size ?? content.length).toString(8).padStart(11, "0")}\0`
    );
    field(148, "        ");
    field(156, entry.type ?? "0");
    field(257, "ustar\0");
    field(345, entry.prefix ?? "");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    field(148, `${checksum.toString(8).padStart(6, "0")}\0 `);
    parts.push(
      header,
      content,
      new Uint8Array((512 - (content.length % 512)) % 512)
    );
  }
  parts.push(new Uint8Array(1024));
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

const fixture = (entries: Entry[]): Response =>
  new Response(gzipSync(tar(entries)));
const skill = (extra: Entry[] = []): Entry[] => [
  { content: "# Skill", name: `${top}/SKILL.md` },
  ...extra,
];
const stub = (respond: () => Response) => {
  const calls: { url: string; headers: Headers }[] = [];
  const fetcher = createGithubSkillFetcher((url, init) => {
    calls.push({ headers: new Headers(init?.headers), url });
    return Promise.resolve(respond());
  });
  return { calls, fetcher };
};
const expectFailure = async (
  promise: Promise<unknown>,
  code: string,
  message: RegExp
) => {
  try {
    await promise;
    throw new Error("Expected failure");
  } catch (error) {
    // biome-ignore lint/suspicious/noMisplacedAssertion: reusable assertion called and awaited inside tests
    expect(error).toBeInstanceOf(GithubSkillSourceError);
    // biome-ignore lint/suspicious/noMisplacedAssertion: reusable assertion called and awaited inside tests
    expect(error).toMatchObject({
      code,
      message: expect.stringMatching(message),
    });
  }
};

describe("parseSource", () => {
  test("uses the shared GitHub URL, path and ref rules", () => {
    expect(
      parseSource({
        path: " /skills/demo/ ",
        provider: "github",
        ref: " feature/new ",
        repoUrl: ` ${repo}.git `,
      })
    ).toEqual({
      path: "/skills/demo/",
      provider: "github",
      ref: "feature/new",
      repoUrl: `${repo}.git`,
    });
    expect(
      parseSource({ provider: "github", ref: sha, repoUrl: repo }).path
    ).toBeUndefined();
    for (const patch of [
      { repoUrl: "https://gitlab.com/acme/skills" },
      { repoUrl: `${repo}/tree/main` },
      { repoUrl: "http://github.com/acme/skills" },
      { repoUrl: "https://github.com/../skills" },
      { path: "skills/../secret" },
      { path: "./skill" },
      { path: "/" },
      { ref: "../main" },
      { ref: "main?token=x" },
      { ref: "///" },
      { ref: "" },
    ]) {
      expect(() =>
        parseSource({
          provider: "github",
          ref: "main",
          repoUrl: repo,
          ...patch,
        })
      ).toThrow();
    }
  });
});

describe("resolveCommit", () => {
  test("resolves a ref with the SHA media type, user agent, and no implicit token", async () => {
    const { calls, fetcher } = stub(() => new Response(`${sha}\n`));
    expect(await fetcher.resolveCommit(`${repo}.git/`, "feature/new")).toBe(
      sha
    );
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/acme/skills/commits/feature%2Fnew"
    );
    expect(calls[0]?.headers.get("Accept")).toBe("application/vnd.github.sha");
    expect(calls[0]?.headers.get("User-Agent")).toBeTruthy();
    expect(calls[0]?.headers.has("Authorization")).toBe(false);
    await fetcher.resolveCommit(repo, "main", "optional-token");
    expect(calls[1]?.headers.get("Authorization")).toBe(
      "Bearer optional-token"
    );
  });

  test("bounds commit responses and reports network failures without exposing credentials", async () => {
    const { fetcher } = stub(() => new Response("a".repeat(2048)));
    await expectFailure(
      fetcher.resolveCommit(repo, "main"),
      "request_failed",
      COMMIT_MESSAGE
    );
    const offline = createGithubSkillFetcher(() =>
      Promise.reject(new Error("offline"))
    );
    await expectFailure(
      offline.resolveCommit(repo, "main", "secret"),
      "request_failed",
      REQUEST_MESSAGE
    );
  });

  test("rejects invalid refs before fetching and malformed SHA responses", async () => {
    const { calls, fetcher } = stub(() => new Response("not a sha"));
    await expect(fetcher.resolveCommit(repo, "../main")).rejects.toThrow();
    expect(calls).toHaveLength(0);
    await expectFailure(
      fetcher.resolveCommit(repo, "main"),
      "request_failed",
      COMMIT_MESSAGE
    );
  });
});

describe("fetchTree", () => {
  test("streams a subdirectory, ignores siblings and large unrelated files, and preserves executable bits", async () => {
    const { calls, fetcher } = stub(() =>
      fixture([
        { content: "", name: "pax_global_header", type: "g" },
        { name: `${top}/`, type: "5" },
        {
          content: new Uint8Array(SKILLS_MAX_BYTES + 1),
          name: `${top}/unrelated`,
        },
        { content: "wrong", name: `${top}/skills/demo-other/SKILL.md` },
        { name: `${top}/skills/demo/`, type: "5" },
        { content: "# Demo", name: `${top}/skills/demo/SKILL.md` },
        {
          content: "#!/bin/sh",
          mode: 0o755,
          name: "scripts/run.sh",
          prefix: `${top}/skills/demo`,
        },
      ])
    );
    const tree = await fetcher.fetchTree(repo, sha, "/skills/demo/");
    expect(tree.commitSha).toBe(sha);
    expect(
      tree.files.map(({ bytes, ...file }) => ({
        ...file,
        content: decoder.decode(bytes),
      }))
    ).toEqual([
      { content: "# Demo", executable: false, path: "SKILL.md" },
      { content: "#!/bin/sh", executable: true, path: "scripts/run.sh" },
    ]);
    expect(calls[0]?.url).toBe(
      `https://codeload.github.com/acme/skills/tar.gz/${sha}`
    );
    expect(calls[0]?.headers.get("User-Agent")).toBeTruthy();
    expect(calls[0]?.headers.has("Authorization")).toBe(false);
    await fetcher.fetchTree(repo, sha, "skills/demo", "explicit-token");
    expect(calls[1]?.headers.get("Authorization")).toBe(
      "Bearer explicit-token"
    );
  });

  test("extracts the repository root and accepts exact byte and file limits", async () => {
    const { fetcher } = stub(() =>
      fixture([
        { content: new Uint8Array(SKILLS_MAX_BYTES), name: `${top}/SKILL.md` },
        ...Array.from({ length: SKILLS_MAX_FILES - 1 }, (_, i) => ({
          name: `${top}/file-${i}`,
        })),
      ])
    );
    expect((await fetcher.fetchTree(repo, sha, undefined)).files).toHaveLength(
      SKILLS_MAX_FILES
    );
  });

  test("refuses file count, single-file and total byte excess before buffering excess files", async () => {
    for (const entries of [
      skill(
        Array.from({ length: SKILLS_MAX_FILES }, (_, i) => ({
          name: `${top}/file-${i}`,
        }))
      ),
      [{ name: `${top}/SKILL.md`, size: SKILLS_MAX_BYTES + 1 }],
      skill([{ name: `${top}/big`, size: SKILLS_MAX_BYTES }]),
    ]) {
      const { fetcher } = stub(() => fixture(entries));
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixtures limit peak memory
      await expectFailure(
        fetcher.fetchTree(repo, sha, undefined),
        "limit_exceeded",
        LIMIT_MESSAGE
      );
    }
  });

  test("requires a root SKILL.md in the selected folder", async () => {
    const { fetcher } = stub(() =>
      fixture([{ content: "nested", name: `${top}/nested/SKILL.md` }])
    );
    await expectFailure(
      fetcher.fetchTree(repo, sha, undefined),
      "invalid_archive",
      SKILL_MESSAGE
    );
  });

  test("refuses links, traversal, unsafe paths, duplicates and file/folder collisions", async () => {
    for (const entries of [
      skill([{ name: `${top}/link`, type: "2" }]),
      skill([{ name: `${top}/link`, type: "1" }]),
      skill([{ name: `${top}/../escape` }]),
      skill([{ name: `${top}/dir/./file` }]),
      skill([{ name: `${top}/dir\\file` }]),
      skill([{ name: `${top}/SKILL.md` }]),
      skill([{ name: `${top}/file` }, { name: `${top}/file/child` }]),
    ]) {
      const { fetcher } = stub(() => fixture(entries));
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixtures limit peak memory
      await expectFailure(
        fetcher.fetchTree(repo, sha, undefined),
        "invalid_archive",
        UNSAFE_MESSAGE
      );
    }
  });

  test("supports PAX long paths and refuses PAX path traversal", async () => {
    const pax = (path: string): string => {
      const value = ` path=${path}\n`;
      let size = value.length + 1;
      while (String(size).length + value.length !== size) {
        size = String(size).length + value.length;
      }
      return `${size}${value}`;
    };
    const longPath = `docs/${"long".repeat(30)}.md`;
    for (const path of [`${top}/${longPath}`, `${top}/../escape`]) {
      const { fetcher } = stub(() =>
        fixture(
          skill([
            { content: pax(path), name: `${top}/pax`, type: "x" },
            { content: "long file", name: `${top}/placeholder` },
          ])
        )
      );
      if (path.includes("..")) {
        // biome-ignore lint/performance/noAwaitInLoops: sequential fixtures limit peak memory
        await expectFailure(
          fetcher.fetchTree(repo, sha, undefined),
          "invalid_archive",
          PATH_MESSAGE
        );
      } else {
        expect(
          (await fetcher.fetchTree(repo, sha, undefined)).files[1]?.path
        ).toBe(longPath);
      }
    }
  });

  test("rejects corrupt headers, truncated tar and invalid gzip", async () => {
    const badChecksum = tar(skill());
    badChecksum[0] = 0;
    for (const bytes of [
      gzipSync(badChecksum),
      gzipSync(tar(skill()).slice(0, 515)),
      encoder.encode("not gzip"),
    ]) {
      const { fetcher } = stub(() => new Response(bytes));
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixtures limit peak memory
      await expectFailure(
        fetcher.fetchTree(repo, sha, undefined),
        "invalid_archive",
        ARCHIVE_MESSAGE
      );
    }
  });

  test("reads compressed input split across tiny chunks and accepts codeload root names", async () => {
    const archiveRoot = `skills-${sha}`;
    const compressed = gzipSync(
      tar([
        { name: `${archiveRoot}/unrelated-link`, type: "2" },
        { content: "# Chunked", name: `${archiveRoot}/demo/SKILL.md` },
      ])
    );
    let cursor = 0;
    const { fetcher } = stub(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (cursor >= compressed.length) {
                controller.close();
                return;
              }
              controller.enqueue(compressed.subarray(cursor, cursor + 7));
              cursor += 7;
            },
          })
        )
    );
    const tree = await fetcher.fetchTree(repo, sha, "demo");
    expect(tree.files.map((file) => decoder.decode(file.bytes))).toEqual([
      "# Chunked",
    ]);
  });

  test("refuses multiple archive roots and absolute paths", async () => {
    for (const entry of [
      { name: "other-root/file" },
      { name: `/${top}/escape` },
    ]) {
      const { fetcher } = stub(() => fixture(skill([entry])));
      // biome-ignore lint/performance/noAwaitInLoops: independent small fixtures are checked in order
      await expectFailure(
        fetcher.fetchTree(repo, sha, undefined),
        "invalid_archive",
        PATH_MESSAGE
      );
    }
  });

  test("requires an exact commit SHA and validates paths before fetching", async () => {
    const { calls, fetcher } = stub(() => fixture(skill()));
    await expect(fetcher.fetchTree(repo, "main", undefined)).rejects.toThrow(
      SHA_MESSAGE
    );
    await expect(fetcher.fetchTree(repo, sha, "../escape")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("caps actual downloaded bytes even without Content-Length and cancels upstream", async () => {
    let cancelled = false;
    const bytes = gzipSync(
      tar(
        skill([{ content: new Uint8Array(64 * 1024), name: `${top}/padding` }])
      )
    );
    const { fetcher } = stub(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
            start(controller) {
              // A single oversized chunk exercises the counter before decompression.
              const chunk = new Uint8Array(50 * 1024 * 1024 + 1);
              chunk.set(bytes);
              controller.enqueue(chunk);
            },
          })
        )
    );
    await expectFailure(
      fetcher.fetchTree(repo, sha, undefined),
      "limit_exceeded",
      DOWNLOAD_MESSAGE
    );
    expect(cancelled).toBe(true);
  });
});

for (const [status, headers, code, message] of [
  [404, {}, "not_found", /not found.*repository|repository.*not found/i],
  [429, { "Retry-After": "60" }, "rate_limited", /rate limit.*60/i],
  [
    403,
    { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1800000000" },
    "rate_limited",
    /rate limit.*retry/i,
  ],
  [403, { "Retry-After": "60" }, "rate_limited", /rate limit.*60/i],
  [403, {}, "request_failed", /403/],
  [500, {}, "request_failed", /500/],
] as const) {
  test(`HTTP ${status} produces typed readable failures for both endpoints`, async () => {
    const { fetcher } = stub(
      () => new Response("failure", { headers, status })
    );
    await expectFailure(fetcher.resolveCommit(repo, "main"), code, message);
    await expectFailure(fetcher.fetchTree(repo, sha, undefined), code, message);
  });
}
