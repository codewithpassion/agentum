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
import type { CommandResult, CommandRunner } from "./command.ts";
import { createWorkFiles, insideWorkDir } from "./work-files.ts";

const AS_AGENT = ["sudo", "-n", "-u", "hm-agent"];
const WORK_DIR = "/home/hm-agent/agentum/w1/a1/work";
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

/** Every command succeeds with no output. */
const answerOk: Answer = () => reply("");

/** `answerOk`, except that the command `binary` gets `result`. */
const replacing = (binary: string, result: CommandResult): Answer =>
  ((cmd, args) =>
    cmd === binary ? result : answerOk(cmd, args)) satisfies Answer;

/** A runner that records each command and answers with `answer`. */
const recordingRunner = (
  answer: Answer = answerOk
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
  const dir = mkdtempSync(join(tmpdir(), "agentum-work-files-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("insideWorkDir resolves a relative path under the work dir and refuses the dir itself", () => {
  expect(insideWorkDir(WORK_DIR, "inbox/notes.txt")).toBe(
    `${WORK_DIR}/inbox/notes.txt`
  );
  expect(() => insideWorkDir(WORK_DIR, ".")).toThrow(
    "is not a path inside the work directory"
  );
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
