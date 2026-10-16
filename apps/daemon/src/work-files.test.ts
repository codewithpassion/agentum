import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "./command.ts";
import { createWorkFiles } from "./work-files.ts";

const AS_AGENT = ["sudo", "-n", "-u", "hm-agent"];
const WORK_DIR = "/home/hm-agent/harbourmaster/w1/a1/work";
const TARGET = `${WORK_DIR}/report.txt`;
const MAX_BYTES = 50;
const BYTES = new TextEncoder().encode("hello world\n");

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

/** Behaves as if the report exists: realpath echoes the path, stat says 12 bytes, head returns BYTES. */
const answerAsFiles: Answer = (binary, args) => {
  switch (binary) {
    case "/usr/bin/realpath":
      return reply(`${args.at(-1) ?? ""}\n`);
    case "/usr/bin/stat":
      return reply("12 81a4\n");
    case "/usr/bin/head":
      return { ...reply(""), stdoutBytes: BYTES };
    default:
      return reply("");
  }
};

/** `answerAsFiles`, except that the command `binary` gets `result`. */
const replacing = (binary: string, result: CommandResult): Answer =>
  ((cmd, args) =>
    cmd === binary ? result : answerAsFiles(cmd, args)) satisfies Answer;

/** A runner that records each command and answers with `answer`. */
const recordingRunner = (
  answer: Answer = answerAsFiles
): { calls: Recorded[]; run: CommandRunner } => {
  const calls: Recorded[] = [];
  const run: CommandRunner = (command, stdin) => {
    calls.push({ command, stdin });
    const [binary = "", ...args] = command.slice(AS_AGENT.length);
    return Promise.resolve(answer(binary, args));
  };
  return { calls, run };
};

const commandsOf = (calls: Recorded[]): string[][] =>
  calls.map((call) => call.command);

const dirs: string[] = [];

const tempDirectory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "harbourmaster-work-files-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("multi-user write makes the folder as hm-agent, then streams the bytes into the file", async () => {
  const { calls, run } = recordingRunner();
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  await files.write("inbox/notes.txt", BYTES);

  expect(calls).toHaveLength(2);
  expect(calls[0]?.command).toEqual([
    ...AS_AGENT,
    "/bin/mkdir",
    "-p",
    `${WORK_DIR}/inbox`,
  ]);
  expect(calls[0]?.stdin).toBeUndefined();
  expect(calls[1]?.command).toEqual([
    ...AS_AGENT,
    "/usr/bin/dd",
    `of=${WORK_DIR}/inbox/notes.txt`,
    "status=none",
  ]);
  expect(calls[1]?.stdin).toEqual(BYTES);
});

test("multi-user write refuses paths that leave the work directory without running anything", async () => {
  const { calls, run } = recordingRunner();
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  const paths = ["../escape.txt", "/etc/passwd", "inbox/../../x"];
  await Promise.all(
    paths.map((path) =>
      expect(files.write(path, BYTES)).rejects.toThrow(
        "is not a path inside the work directory"
      )
    )
  );
  expect(calls).toEqual([]);
});

test("multi-user write reports a failing mkdir and skips the dd", async () => {
  const { calls, run } = recordingRunner(
    replacing(
      "/bin/mkdir",
      reply("", 1, "  mkdir: cannot create directory: Permission denied\n")
    )
  );
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  await expect(files.write("inbox/notes.txt", BYTES)).rejects.toThrow(
    "mkdir failed: mkdir: cannot create directory: Permission denied"
  );
  expect(commandsOf(calls).map((command) => command[4])).toEqual([
    "/bin/mkdir",
  ]);
});

test("multi-user write reports a failing dd with its trimmed stderr", async () => {
  const { run } = recordingRunner(
    replacing("/usr/bin/dd", reply("", 1, "dd: failed to open: No space\n\n"))
  );
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  await expect(files.write("inbox/notes.txt", BYTES)).rejects.toThrow(
    "dd failed: dd: failed to open: No space"
  );
});

test("multi-user resolveOutbound vets a regular file with realpath, then the work dir, then stat", async () => {
  const { calls, run } = recordingRunner();
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  const result = await files.resolveOutbound(["report.txt"], MAX_BYTES);

  expect(commandsOf(calls)).toEqual([
    [...AS_AGENT, "/usr/bin/realpath", "-e", "--", TARGET],
    [...AS_AGENT, "/usr/bin/realpath", "-e", "--", WORK_DIR],
    [...AS_AGENT, "/usr/bin/stat", "-c", "%s %f", "--", TARGET],
  ]);
  expect(result).toEqual({
    files: [
      {
        mime: "text/plain",
        name: "report.txt",
        path: TARGET,
        size: 12,
      },
    ],
    rejected: [],
  });
});

test("multi-user resolveOutbound accepts an empty regular file", async () => {
  const { run } = recordingRunner(
    replacing("/usr/bin/stat", reply("0 81a4\n"))
  );
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  const result = await files.resolveOutbound(["report.txt"], MAX_BYTES);

  expect(result.files).toEqual([
    { mime: "text/plain", name: "report.txt", path: TARGET, size: 0 },
  ]);
});

test("multi-user resolveOutbound asks for the work dir's realpath only once", async () => {
  const { calls, run } = recordingRunner();
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  const result = await files.resolveOutbound(
    ["a.txt", "b.txt", "c.txt"],
    MAX_BYTES
  );

  const rootChecks = commandsOf(calls).filter(
    (command) => command.at(-1) === WORK_DIR
  );
  expect(rootChecks).toHaveLength(1);
  expect(result.files.map((file) => file.name)).toEqual([
    "a.txt",
    "b.txt",
    "c.txt",
  ]);
});

test("multi-user resolveOutbound refuses paths outside the work dir with no runner calls", async () => {
  const { calls, run } = recordingRunner();
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  const result = await files.resolveOutbound(
    ["/etc/passwd", "../x.txt", `${WORK_DIR}-evil/x.txt`],
    MAX_BYTES
  );

  expect(result.files).toEqual([]);
  expect(result.rejected.map((file) => file.reason)).toEqual([
    "outside_root",
    "outside_root",
    "outside_root",
  ]);
  expect(calls).toEqual([]);
});

test("multi-user resolveOutbound refuses a symlink whose real path is outside, without stat or head", async () => {
  const escaped = "/home/hm-agent/.claude/.credentials.json";
  const { calls, run } = recordingRunner((binary, args) =>
    binary === "/usr/bin/realpath" && args.at(-1) === TARGET
      ? reply(`${escaped}\n`)
      : answerAsFiles(binary, args)
  );
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  const result = await files.resolveOutbound(["report.txt"], MAX_BYTES);

  expect(result.files).toEqual([]);
  expect(result.rejected).toEqual([
    {
      name: "report.txt",
      path: TARGET,
      reason: "outside_root",
    },
  ]);
  const binaries = commandsOf(calls).map((command) => command[4]);
  expect(binaries).not.toContain("/usr/bin/stat");
  expect(binaries).not.toContain("/usr/bin/head");
});

test("multi-user resolveOutbound reports a path realpath cannot find as missing", async () => {
  const { calls, run } = recordingRunner((binary, args) =>
    binary === "/usr/bin/realpath" && args.at(-1) === TARGET
      ? reply("", 1, "realpath: No such file or directory\n")
      : answerAsFiles(binary, args)
  );
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  const result = await files.resolveOutbound(["report.txt"], MAX_BYTES);

  expect(result.files).toEqual([]);
  expect(result.rejected.map((file) => file.reason)).toEqual(["missing"]);
  expect(commandsOf(calls).map((command) => command[4])).not.toContain(
    "/usr/bin/stat"
  );
});

test("multi-user resolveOutbound reports a directory as not_a_file", async () => {
  const { run } = recordingRunner(
    replacing("/usr/bin/stat", reply("4096 41ed\n"))
  );
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  const result = await files.resolveOutbound(["report.txt"], MAX_BYTES);

  expect(result.rejected.map((file) => file.reason)).toEqual(["not_a_file"]);
});

test("multi-user resolveOutbound refuses a file above maxBytes without reading it", async () => {
  const { calls, run } = recordingRunner(
    replacing("/usr/bin/stat", reply("100 81a4\n"))
  );
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  const result = await files.resolveOutbound(["report.txt"], MAX_BYTES);

  expect(result.files).toEqual([]);
  expect(result.rejected.map((file) => file.reason)).toEqual(["too_large"]);
  expect(commandsOf(calls).map((command) => command[4])).not.toContain(
    "/usr/bin/head"
  );
});

test("multi-user read streams the file with head and returns its bytes as a Blob of its mime type", async () => {
  const { calls, run } = recordingRunner();
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  const blob = await files.read({
    mime: "text/plain",
    name: "report.txt",
    path: TARGET,
    size: BYTES.length,
  });

  expect(commandsOf(calls)).toEqual([
    [...AS_AGENT, "/usr/bin/head", "-c", String(BYTES.length), "--", TARGET],
  ]);
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(BYTES);
  // Bun appends `;charset=utf-8` to text types, so compare the media type alone.
  expect(blob.type.split(";")[0]).toBe("text/plain");
});

test("multi-user read reports a failing head with its trimmed stderr", async () => {
  const { run } = recordingRunner(
    replacing("/usr/bin/head", reply("", 1, "head: cannot open 'x': Denied\n"))
  );
  const files = createWorkFiles({ run, singleUser: false, workDir: WORK_DIR });

  await expect(
    files.read({
      mime: "text/plain",
      name: "report.txt",
      path: TARGET,
      size: BYTES.length,
    })
  ).rejects.toThrow("head failed: head: cannot open 'x': Denied");
});

test("single-user write creates inbox/ and the file, and refuses a path outside, with no runner calls", async () => {
  const workDir = join(tempDirectory(), "work");
  mkdirSync(workDir);
  const { calls, run } = recordingRunner();
  const files = createWorkFiles({ run, singleUser: true, workDir });

  await files.write("inbox/notes.txt", BYTES);

  expect(
    new Uint8Array(readFileSync(join(workDir, "inbox", "notes.txt")))
  ).toEqual(BYTES);
  await expect(files.write("../x", BYTES)).rejects.toThrow(
    "is not a path inside the work directory"
  );
  expect(existsSync(join(workDir, "..", "x"))).toBe(false);
  expect(calls).toEqual([]);
});

test("single-user resolveOutbound accepts a file inside and refuses one outside or a symlink to one", async () => {
  const root = tempDirectory();
  const workDir = join(root, "work");
  const outside = join(root, "outside");
  mkdirSync(workDir);
  mkdirSync(outside);
  writeFileSync(join(workDir, "report.txt"), BYTES);
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(workDir, "link.txt"));
  const { calls, run } = recordingRunner();
  const files = createWorkFiles({ run, singleUser: true, workDir });

  const result = await files.resolveOutbound(
    [
      "report.txt",
      join(outside, "secret.txt"),
      "link.txt",
      "../outside/secret.txt",
    ],
    MAX_BYTES
  );

  expect(result.files).toEqual([
    {
      mime: "text/plain",
      name: "report.txt",
      path: realpathSync(join(workDir, "report.txt")),
      size: BYTES.length,
    },
  ]);
  expect(result.rejected.map((file) => file.reason)).toEqual([
    "outside_root",
    "outside_root",
    "outside_root",
  ]);
  expect(calls).toEqual([]);
});

test("single-user read returns the file's bytes", async () => {
  const workDir = tempDirectory();
  const path = join(workDir, "report.txt");
  writeFileSync(path, BYTES);
  const { calls, run } = recordingRunner();
  const files = createWorkFiles({ run, singleUser: true, workDir });

  const blob = await files.read({
    mime: "text/plain",
    name: "report.txt",
    path,
    size: BYTES.length,
  });

  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(BYTES);
  expect(calls).toEqual([]);
});
