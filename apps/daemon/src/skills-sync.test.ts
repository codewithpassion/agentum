// Tests for the skills sync: the files land under `.claude/skills/` in both
// modes, every path is vetted before anything is downloaded, the caps refuse
// an oversized list, and a failure or an abort leaves nothing written.
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SKILLS_MAX_BYTES,
  SKILLS_MAX_FILES,
  type SkillFile,
} from "@repo/protocol/skills";
import { AS_AGENT } from "./agent-user.ts";
import type { CommandResult, CommandRunner } from "./command.ts";
import { RunApiError } from "./run-api.ts";
import type { SkillsApi } from "./skills-api.ts";
import { SKILLS_DIR, syncSkills } from "./skills-sync.ts";
import { createWorkFiles } from "./work-files.ts";

const WORK_DIR = "/home/hm-agent/harbourmaster/w1/a1/work";
const NOT_FOUND = 404;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const SHOUT_SKILL = encode("# shout\n");
const HELPER = encode("echo shout\n");
const REVIEW_SKILL = encode("# review\n");
const SHARED_TONE = encode("Plain words.\n");

/** Two agent skills (one with a nested helper) and one shared skill. */
const SKILLS: Record<string, Uint8Array> = {
  "review/SKILL.md": REVIEW_SKILL,
  "shared-tone/SKILL.md": SHARED_TONE,
  "shout/SKILL.md": SHOUT_SKILL,
  "shout/scripts/helper.sh": HELPER,
};

interface FakeApi extends SkillsApi {
  downloads: string[];
}

/**
 * An API that lists `listing` and serves `bytes` by path. `failOn` makes the
 * download of that path reject with a 404, and `onDownload` runs before each.
 */
const fakeApi = (
  listing: SkillFile[],
  bytes: Record<string, Uint8Array>,
  options: { failOn?: string; onDownload?: () => void } = {}
): FakeApi => {
  const downloads: string[] = [];
  return {
    downloads,
    file: (path) => {
      downloads.push(path);
      options.onDownload?.();
      if (path === options.failOn) {
        return Promise.reject(
          new RunApiError("files file answered HTTP 404", NOT_FOUND)
        );
      }
      return Promise.resolve(bytes[path] ?? new Uint8Array());
    },
    list: () => Promise.resolve(listing),
  };
};

/** The listing that `SKILLS` describes. */
const skillListing = (): SkillFile[] =>
  Object.entries(SKILLS).map(([path, bytes]) => ({
    etag: `"${path}"`,
    path,
    size: bytes.length,
  }));

interface Recorded {
  command: string[];
  stdin: Uint8Array | undefined;
}

/** A runner that records each command and answers exit 0, or `exitCode` for dd. */
const recordingRunner = (
  ddExitCode = 0
): { calls: Recorded[]; run: CommandRunner } => {
  const calls: Recorded[] = [];
  const run: CommandRunner = (command, stdin) => {
    calls.push({ command, stdin });
    const isDd = command.at(AS_AGENT.length) === "/usr/bin/dd";
    const result: CommandResult = {
      exitCode: isDd ? ddExitCode : 0,
      stderr: isDd && ddExitCode !== 0 ? "dd: no space\n" : "",
      stdout: "",
    };
    return Promise.resolve(result);
  };
  return { calls, run };
};

const noRunner: CommandRunner = () =>
  Promise.reject(new Error("no command expected in single-user mode"));

const dirs: string[] = [];

const tempWorkDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), "harbourmaster-skills-sync-"));
  dirs.push(root);
  const workDir = join(root, "work");
  mkdirSync(workDir);
  return workDir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const singleUserFiles = (workDir: string) =>
  createWorkFiles({ run: noRunner, singleUser: true, workDir });

test("single-user sync writes every skill file under .claude/skills/", async () => {
  const workDir = tempWorkDir();
  const api = fakeApi(skillListing(), SKILLS);

  const written = await syncSkills({ api, files: singleUserFiles(workDir) });

  expect(written).toBe(4);
  for (const [path, bytes] of Object.entries(SKILLS)) {
    const onDisk = readFileSync(join(workDir, SKILLS_DIR, path));
    expect(new Uint8Array(onDisk)).toEqual(new Uint8Array(bytes));
  }
});

test("multi-user sync makes each folder as hm-agent and streams each file in with dd", async () => {
  const { calls, run } = recordingRunner();
  const api = fakeApi(skillListing(), SKILLS);

  const written = await syncSkills({
    api,
    files: createWorkFiles({ run, singleUser: false, workDir: WORK_DIR }),
  });

  expect(written).toBe(4);
  const mkdirs = calls
    .filter((call) => call.command.at(AS_AGENT.length) === "/bin/mkdir")
    .map((call) => call.command.at(-1));
  expect(mkdirs).toEqual([
    `${WORK_DIR}/${SKILLS_DIR}/review`,
    `${WORK_DIR}/${SKILLS_DIR}/shared-tone`,
    `${WORK_DIR}/${SKILLS_DIR}/shout`,
    `${WORK_DIR}/${SKILLS_DIR}/shout/scripts`,
  ]);
  const writes = calls
    .filter((call) => call.command.at(AS_AGENT.length) === "/usr/bin/dd")
    .map((call) => ({
      bytes: call.stdin,
      of: call.command.at(AS_AGENT.length + 1),
    }));
  expect(writes).toEqual(
    Object.entries(SKILLS).map(([path, bytes]) => ({
      bytes,
      of: `of=${WORK_DIR}/${SKILLS_DIR}/${path}`,
    }))
  );
  for (const call of calls) {
    expect(call.command.slice(0, AS_AGENT.length)).toEqual([...AS_AGENT]);
  }
});

test("a path with '..' is refused, and nothing is downloaded or written", async () => {
  const workDir = tempWorkDir();
  const listing: SkillFile[] = [
    ...skillListing(),
    { etag: '"x"', path: "shout/../../escape.txt", size: 1 },
  ];
  const api = fakeApi(listing, SKILLS);

  await expect(
    syncSkills({ api, files: singleUserFiles(workDir) })
  ).rejects.toThrow("shout/../../escape.txt");
  expect(api.downloads).toEqual([]);
  expect(existsSync(join(workDir, SKILLS_DIR))).toBe(false);
  expect(existsSync(join(workDir, "..", "escape.txt"))).toBe(false);
});

test.each([
  ["an absolute path", "/shout/SKILL.md"],
  ["a one-segment path", "SKILL.md"],
  ["a backslash path", "shout\\SKILL.md"],
  ["a control character", "shout/SKILL\u0007.md"],
  ["an empty segment", "shout//SKILL.md"],
  ["a '.' segment", "shout/./SKILL.md"],
  ["an empty path", ""],
])("%s is refused before anything is downloaded", async (_label, badPath) => {
  const workDir = tempWorkDir();
  const listing: SkillFile[] = [
    ...skillListing(),
    { etag: '"x"', path: badPath, size: 1 },
  ];
  const api = fakeApi(listing, SKILLS);

  await expect(
    syncSkills({ api, files: singleUserFiles(workDir) })
  ).rejects.toThrow("Refused skill path");
  expect(api.downloads).toEqual([]);
  expect(existsSync(join(workDir, SKILLS_DIR))).toBe(false);
});

test("a list over the file cap is refused before any download", async () => {
  const workDir = tempWorkDir();
  const listing: SkillFile[] = Array.from(
    { length: SKILLS_MAX_FILES + 1 },
    (_unused, index) => ({ etag: '"x"', path: `bulk/f${index}.md`, size: 0 })
  );
  const api = fakeApi(listing, {});

  await expect(
    syncSkills({ api, files: singleUserFiles(workDir) })
  ).rejects.toThrow(`more than the ${SKILLS_MAX_FILES} allowed`);
  expect(api.downloads).toEqual([]);
});

test("a list whose sizes sum above the byte cap is refused before any download", async () => {
  const workDir = tempWorkDir();
  const half = Math.floor(SKILLS_MAX_BYTES / 2) + 1;
  const listing: SkillFile[] = [
    { etag: '"a"', path: "big/a.bin", size: half },
    { etag: '"b"', path: "big/b.bin", size: half },
  ];
  const api = fakeApi(listing, {});

  await expect(
    syncSkills({ api, files: singleUserFiles(workDir) })
  ).rejects.toThrow(`more than the ${SKILLS_MAX_BYTES} allowed`);
  expect(api.downloads).toEqual([]);
});

test("a failed download writes nothing, not even the files fetched before it", async () => {
  const workDir = tempWorkDir();
  const api = fakeApi(skillListing(), SKILLS, {
    failOn: "shout/scripts/helper.sh",
  });

  await expect(
    syncSkills({ api, files: singleUserFiles(workDir) })
  ).rejects.toThrow("HTTP 404");
  expect(existsSync(join(workDir, SKILLS_DIR))).toBe(false);
});

test("a failed write rejects with the write's error", async () => {
  const { run } = recordingRunner(1);
  const api = fakeApi(skillListing(), SKILLS);

  await expect(
    syncSkills({
      api,
      files: createWorkFiles({ run, singleUser: false, workDir: WORK_DIR }),
    })
  ).rejects.toThrow("dd failed: dd: no space");
});

test("an already aborted signal rejects before the list is asked for", async () => {
  const workDir = tempWorkDir();
  const controller = new AbortController();
  controller.abort();
  const api = fakeApi(skillListing(), SKILLS);

  await expect(
    syncSkills({
      api,
      files: singleUserFiles(workDir),
      signal: controller.signal,
    })
  ).rejects.toThrow();
  expect(api.downloads).toEqual([]);
  expect(existsSync(join(workDir, SKILLS_DIR))).toBe(false);
});

test("an abort during the downloads rejects and writes nothing", async () => {
  const workDir = tempWorkDir();
  const controller = new AbortController();
  const api = fakeApi(skillListing(), SKILLS, {
    onDownload: () => controller.abort(),
  });

  await expect(
    syncSkills({
      api,
      files: singleUserFiles(workDir),
      signal: controller.signal,
    })
  ).rejects.toThrow();
  expect(api.downloads).toHaveLength(1);
  expect(existsSync(join(workDir, SKILLS_DIR))).toBe(false);
});
