import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "./command.ts";
import { createWorkDisk } from "./work-disk.ts";

const AS_AGENT = ["sudo", "-n", "-u", "hm-agent"];
const WORK_DIR = "/home/hm-agent/harbourmaster/w1/a1/work";
const BYTES = new TextEncoder().encode("hello world\n");
const FILE_MODE = "81a4";
const FOLDER_MODE = "41ed";
const LINK_MODE = "a1ff";
const LIST_FORMAT = "%y\\t%f\\0";
const NO_SUCH = "stat: cannot statx 'x': No such file or directory\n";

interface Recorded {
  command: string[];
  stdin: Uint8Array | undefined;
}

/** Answers a command run as hm-agent by its binary and its arguments. */
type Answer = (binary: string, args: string[]) => CommandResult;

const reply = (stdout: string, exitCode = 0, stderr = ""): CommandResult => ({
  exitCode,
  stderr,
  stdout,
});

/** A recording runner: each command is logged, then answered by `answer`. */
const recordingRunner = (
  answer: Answer
): { calls: Recorded[]; run: CommandRunner } => {
  const calls: Recorded[] = [];
  const run: CommandRunner = (command, stdin) => {
    calls.push({ command, stdin });
    const [binary = "", ...args] = command.slice(AS_AGENT.length);
    return Promise.resolve(answer(binary, args));
  };
  return { calls, run };
};

const binariesOf = (calls: Recorded[]): string[] =>
  calls.map((call) => call.command[AS_AGENT.length] ?? "");

const dirs: string[] = [];

const tempDirectory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "harbourmaster-work-disk-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("single-user write then read round-trips through a nested folder", async () => {
  const workDir = tempDirectory();
  const { calls, run } = recordingRunner(() => reply(""));
  const disk = createWorkDisk({ run, singleUser: true, workDir });

  await disk.write("library/docs/notes.txt", BYTES);

  expect(
    new Uint8Array(readFileSync(join(workDir, "library", "docs", "notes.txt")))
  ).toEqual(BYTES);
  expect(await disk.read("library/docs/notes.txt")).toEqual(BYTES);
  expect(calls).toEqual([]);
});

test("single-user list shows files and folders and leaves out a symlink", async () => {
  const workDir = tempDirectory();
  const box = join(workDir, "box");
  mkdirSync(join(box, "sub"), { recursive: true });
  writeFileSync(join(box, "a.txt"), BYTES);
  symlinkSync(join(box, "a.txt"), join(box, "link.txt"));
  const { calls, run } = recordingRunner(() => reply(""));
  const disk = createWorkDisk({ run, singleUser: true, workDir });

  const entries = await disk.list("box");

  expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    { kind: "file", name: "a.txt" },
    { kind: "dir", name: "sub" },
  ]);
  expect(calls).toEqual([]);
});

test("single-user list of a missing folder is empty", async () => {
  const workDir = tempDirectory();
  const disk = createWorkDisk({
    run: recordingRunner(() => reply("")).run,
    singleUser: true,
    workDir,
  });

  expect(await disk.list("nowhere/at/all")).toEqual([]);
});

test("single-user stat reports a file, a folder, a missing path and a symlink", async () => {
  const workDir = tempDirectory();
  mkdirSync(join(workDir, "folder"));
  writeFileSync(join(workDir, "file.txt"), BYTES);
  symlinkSync(join(workDir, "file.txt"), join(workDir, "link.txt"));
  const disk = createWorkDisk({
    run: recordingRunner(() => reply("")).run,
    singleUser: true,
    workDir,
  });

  expect(await disk.stat("file.txt")).toEqual({
    kind: "file",
    size: BYTES.length,
  });
  expect((await disk.stat("folder"))?.kind).toBe("dir");
  expect(await disk.stat("missing.txt")).toBeNull();
  expect(await disk.stat("file.txt/inside")).toBeNull();
  expect(await disk.stat("link.txt")).toBeNull();
});

test("single-user remove deletes a file and accepts a missing path", async () => {
  const workDir = tempDirectory();
  writeFileSync(join(workDir, "gone.txt"), BYTES);
  const disk = createWorkDisk({
    run: recordingRunner(() => reply("")).run,
    singleUser: true,
    workDir,
  });

  await disk.remove("gone.txt");
  await disk.remove("gone.txt");
  await disk.remove("never/was/here.txt");

  expect(await disk.stat("gone.txt")).toBeNull();
});

test("single-user refuses paths with .. or an absolute path before touching the disk", async () => {
  const workDir = tempDirectory();
  const disk = createWorkDisk({
    run: recordingRunner(() => reply("")).run,
    singleUser: true,
    workDir,
  });

  const refused = "is not a path inside the work directory";
  const paths = ["../escape.txt", "/etc/passwd", "box/../../x"];
  await Promise.all(
    paths.flatMap((path) => [
      expect(disk.write(path, BYTES)).rejects.toThrow(refused),
      expect(disk.read(path)).rejects.toThrow(refused),
      expect(disk.list(path)).rejects.toThrow(refused),
      expect(disk.stat(path)).rejects.toThrow(refused),
      expect(disk.remove(path)).rejects.toThrow(refused),
    ])
  );
});

test("multi-user write makes the folder as hm-agent, then streams the bytes into the file", async () => {
  const { calls, run } = recordingRunner(() => reply(""));
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  await disk.write("library/a.txt", BYTES);

  expect(calls).toHaveLength(2);
  expect(calls[0]?.command).toEqual([
    ...AS_AGENT,
    "/bin/mkdir",
    "-p",
    `${WORK_DIR}/library`,
  ]);
  expect(calls[1]?.command).toEqual([
    ...AS_AGENT,
    "/usr/bin/dd",
    `of=${WORK_DIR}/library/a.txt`,
    "status=none",
  ]);
  expect(calls[1]?.stdin).toEqual(BYTES);
});

test("multi-user write reports a failing mkdir and skips the dd", async () => {
  const { calls, run } = recordingRunner((binary) =>
    binary === "/bin/mkdir"
      ? reply("", 1, "mkdir: cannot create directory: Permission denied\n")
      : reply("")
  );
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  await expect(disk.write("library/a.txt", BYTES)).rejects.toThrow(
    "mkdir failed: mkdir: cannot create directory: Permission denied"
  );
  expect(binariesOf(calls)).toEqual(["/bin/mkdir"]);
});

test("multi-user read runs dd and returns the raw bytes", async () => {
  const { calls, run } = recordingRunner(() => ({
    ...reply(""),
    stdoutBytes: BYTES,
  }));
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  expect(await disk.read("library/a.txt")).toEqual(BYTES);
  expect(calls.map((call) => call.command)).toEqual([
    [...AS_AGENT, "/usr/bin/dd", `if=${WORK_DIR}/library/a.txt`, "status=none"],
  ]);
});

test("multi-user read falls back to the text of stdout when no bytes are given", async () => {
  const { run } = recordingRunner(() => reply("hi"));
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  expect(await disk.read("a.txt")).toEqual(new TextEncoder().encode("hi"));
});

test("multi-user read throws on a non-zero dd exit", async () => {
  const { run } = recordingRunner(() =>
    reply("", 1, "dd: failed to open 'x': Permission denied\n")
  );
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  await expect(disk.read("a.txt")).rejects.toThrow(
    "dd failed: dd: failed to open 'x': Permission denied"
  );
});

test("multi-user remove runs rm -f on the absolute path", async () => {
  const { calls, run } = recordingRunner(() => reply(""));
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  await disk.remove("library/a.txt");

  expect(calls.map((call) => call.command)).toEqual([
    [...AS_AGENT, "/bin/rm", "-f", "--", `${WORK_DIR}/library/a.txt`],
  ]);
});

test("multi-user remove accepts a path that is not there", async () => {
  const { run } = recordingRunner(() =>
    reply("", 1, "rm: cannot remove 'a/b': No such file or directory\n")
  );
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  await expect(disk.remove("a/b")).resolves.toBeUndefined();
});

test("multi-user remove accepts a path under a file, which is not there either", async () => {
  const { run } = recordingRunner(() =>
    reply("", 1, "rm: cannot remove 'a/b': Not a directory\n")
  );
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  await expect(disk.remove("a/b")).resolves.toBeUndefined();
});

test("multi-user remove throws on any other failure", async () => {
  const { run } = recordingRunner(() =>
    reply("", 1, "rm: cannot remove 'a': Permission denied\n")
  );
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  await expect(disk.remove("a")).rejects.toThrow(
    "rm failed: rm: cannot remove 'a': Permission denied"
  );
});

test("multi-user stat runs stat without -L and reads the file type nibble", async () => {
  const { calls, run } = recordingRunner(() => reply(`12 ${FILE_MODE}\n`));
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  expect(await disk.stat("a.txt")).toEqual({ kind: "file", size: 12 });
  expect(calls.map((call) => call.command)).toEqual([
    [...AS_AGENT, "/usr/bin/stat", "-c", "%s %f", "--", `${WORK_DIR}/a.txt`],
  ]);
});

test("multi-user stat reads a folder nibble as dir", async () => {
  const { run } = recordingRunner(() => reply(`4096 ${FOLDER_MODE}\n`));
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  expect(await disk.stat("folder")).toEqual({ kind: "dir", size: 4096 });
});

test("multi-user stat reports a link as null", async () => {
  const { run } = recordingRunner(() => reply(`9 ${LINK_MODE}\n`));
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  expect(await disk.stat("link.txt")).toBeNull();
});

test("multi-user stat answers null for a missing path and throws on other failures", async () => {
  const missing = recordingRunner(() => reply("", 1, NO_SUCH));
  await expect(
    createWorkDisk({
      run: missing.run,
      singleUser: false,
      workDir: WORK_DIR,
    }).stat("a.txt")
  ).resolves.toBeNull();

  const notDir = recordingRunner(() =>
    reply("", 1, "stat: cannot statx 'x': Not a directory\n")
  );
  await expect(
    createWorkDisk({
      run: notDir.run,
      singleUser: false,
      workDir: WORK_DIR,
    }).stat("a.txt/b")
  ).resolves.toBeNull();

  const denied = recordingRunner(() =>
    reply("", 1, "stat: cannot statx 'x': Permission denied\n")
  );
  await expect(
    createWorkDisk({
      run: denied.run,
      singleUser: false,
      workDir: WORK_DIR,
    }).stat("a.txt")
  ).rejects.toThrow("stat failed: stat: cannot statx 'x': Permission denied");
});

test("multi-user list runs find at depth one with the NUL and tab format", async () => {
  const { calls, run } = recordingRunner(() => reply(""));
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  await disk.list("library");

  expect(calls.map((call) => call.command)).toEqual([
    [
      ...AS_AGENT,
      "/usr/bin/find",
      `${WORK_DIR}/library`,
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-printf",
      LIST_FORMAT,
    ],
  ]);
});

test("multi-user list parses records, keeps spaces in names and leaves out links", async () => {
  const output = [
    "f\tnotes.txt",
    "d\tsub folder",
    "l\tlink.txt",
    "f\ta\tb.txt",
    "",
  ].join("\0");
  const { run } = recordingRunner(() => reply(output));
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  expect(await disk.list("library")).toEqual([
    { kind: "file", name: "notes.txt" },
    { kind: "dir", name: "sub folder" },
    { kind: "file", name: "a\tb.txt" },
  ]);
});

test("multi-user list answers empty for a missing folder and throws on other failures", async () => {
  const missing = recordingRunner(() =>
    reply("", 1, "find: '/x': No such file or directory\n")
  );
  await expect(
    createWorkDisk({
      run: missing.run,
      singleUser: false,
      workDir: WORK_DIR,
    }).list("library")
  ).resolves.toEqual([]);

  const denied = recordingRunner(() =>
    reply("", 1, "find: '/x': Permission denied\n")
  );
  await expect(
    createWorkDisk({
      run: denied.run,
      singleUser: false,
      workDir: WORK_DIR,
    }).list("library")
  ).rejects.toThrow("find failed: find: '/x': Permission denied");
});

test("multi-user refuses paths outside the work directory before running anything", async () => {
  const { calls, run } = recordingRunner(() => reply(""));
  const disk = createWorkDisk({ run, singleUser: false, workDir: WORK_DIR });

  await expect(disk.read("../x")).rejects.toThrow(
    "is not a path inside the work directory"
  );
  await expect(disk.stat("/etc/passwd")).rejects.toThrow(
    "is not a path inside the work directory"
  );
  expect(calls).toEqual([]);
});
