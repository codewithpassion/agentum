import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type {
  ExecutionEnv,
  ExecutionError,
  FileError,
  Result,
  ShellOutputInfo,
} from "@earendil-works/pi-durable/env";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { bytesOf, createFakeVm, textOf } from "./fake-vm.ts";
import {
  createVmEnv,
  DEFAULT_EXEC_TIMEOUT_MS,
  EXEC_OUTPUT_BYTES,
  MAX_EXEC_TIMEOUT_MS,
} from "./vm-env.ts";

const WORKDIR = "/workspace";

/** Tool calls take the environment as `api.env`; the rest of the API is not used here. */
const apiFor = (env: ExecutionEnv) => ({ env }) as unknown as ToolExecutionApi;

const okValue = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) {
    throw new Error("Expected the call to succeed");
  }
  return result.value;
};

const errorOf = <T, E>(result: Result<T, E>): E => {
  if (result.ok) {
    throw new Error("Expected the call to fail");
  }
  return result.error;
};

const setup = (cwd?: string) => {
  const vm = createFakeVm();
  const env = createVmEnv({ cwd, sessionId: "s1", vm });
  return { env, vm };
};

const abortedContext = (): Context => {
  const controller = new AbortController();
  controller.abort();
  return { ...BACKGROUND_CONTEXT, abortSignal: controller.signal };
};

interface Chunk {
  stream: ShellOutputInfo["stream"];
  text: string;
}

/** An `onOutput` callback that records each chunk it is given. */
const recorder = () => {
  const chunks: Chunk[] = [];
  const onOutput = (text: string, _context: Context, info: ShellOutputInfo) => {
    chunks.push({ stream: info.stream, text });
  };
  return { chunks, onOutput };
};

test("the write, read and edit tools round-trip a file through the VM", async () => {
  const { env, vm } = setup();
  const api = apiFor(env);

  await createWriteTool().execute(
    { content: "alpha\nbeta\n", path: "notes/a.md" },
    api,
    BACKGROUND_CONTEXT
  );
  expect(textOf(vm.files.get("/workspace/notes/a.md"))).toBe("alpha\nbeta\n");

  const read = await createReadTool().execute(
    { path: "/workspace/notes/a.md" },
    api,
    BACKGROUND_CONTEXT
  );
  expect(read.output).toEqual([{ text: "alpha\nbeta\n", type: "text" }]);

  await createEditTool().execute(
    { edits: [{ newText: "gamma", oldText: "beta" }], path: "notes/a.md" },
    api,
    BACKGROUND_CONTEXT
  );
  expect(textOf(vm.files.get("/workspace/notes/a.md"))).toBe("alpha\ngamma\n");
});

test("a missing file fails with not_found, and a file listed as a directory with not_directory", async () => {
  const { env, vm } = setup();
  vm.files.set("/workspace/a.txt", bytesOf("x"));

  const missing = await env.readTextFile("missing.txt", BACKGROUND_CONTEXT);
  expect(errorOf(missing).code).toBe("not_found");

  const notDirectory = await env.listDir("a.txt", BACKGROUND_CONTEXT);
  expect(errorOf(notDirectory).code).toBe("not_directory");
});

test("listDir returns each entry with its kind and size", async () => {
  const { env, vm } = setup();
  vm.files.set("/workspace/a.txt", bytesOf("abc"));
  vm.folders.add("/workspace/sub");

  const listed = okValue(await env.listDir(".", BACKGROUND_CONTEXT))
    .map((info) => ({ kind: info.kind, name: info.name, size: info.size }))
    .sort((left, right) => left.name.localeCompare(right.name));
  expect(listed).toEqual([
    { kind: "file", name: "a.txt", size: 3 },
    { kind: "directory", name: "sub", size: 0 },
  ]);
});

test("relative paths resolve against cwd, and '..' is clamped at the root", async () => {
  const { env, vm } = setup("/workspace/sub");
  vm.folders.add("/workspace/sub");

  okValue(await env.writeFile("a.txt", "one", BACKGROUND_CONTEXT));
  expect(textOf(vm.files.get("/workspace/sub/a.txt"))).toBe("one");

  okValue(await env.writeFile("../top.txt", "two", BACKGROUND_CONTEXT));
  expect(textOf(vm.files.get("/workspace/top.txt"))).toBe("two");

  okValue(
    await env.writeFile("../../../escape.txt", "three", BACKGROUND_CONTEXT)
  );
  expect(textOf(vm.files.get("/escape.txt"))).toBe("three");

  okValue(
    await env.writeFile("/workspace/abs.txt", "four", BACKGROUND_CONTEXT)
  );
  expect(textOf(vm.files.get("/workspace/abs.txt"))).toBe("four");
  expect(env.cwd).toBe("/workspace/sub");
});

test("the env id names the session, and cwd defaults to the VM workdir", () => {
  const { env } = setup();
  expect(env.id).toBe("harbourmaster:vm:s1");
  expect(env.cwd).toBe(WORKDIR);
});

test("appendFile treats a missing file as empty, and truncateFile resizes", async () => {
  const { env, vm } = setup();

  okValue(await env.appendFile("log.txt", "a", BACKGROUND_CONTEXT));
  okValue(await env.appendFile("log.txt", bytesOf("bc"), BACKGROUND_CONTEXT));
  expect(textOf(vm.files.get("/workspace/log.txt"))).toBe("abc");

  okValue(await env.truncateFile("log.txt", 2, BACKGROUND_CONTEXT));
  expect(textOf(vm.files.get("/workspace/log.txt"))).toBe("ab");

  okValue(await env.truncateFile("log.txt", 4, BACKGROUND_CONTEXT));
  expect(vm.files.get("/workspace/log.txt")?.byteLength).toBe(4);
});

test("exec delivers stdout, then stderr, and returns the exit code", async () => {
  const { env, vm } = setup();
  vm.onExec = () => ({
    exitCode: 3,
    stderr: "warn\n",
    stdout: "hi\n",
    timedOut: false,
    truncated: false,
  });
  const { chunks, onOutput } = recorder();

  const result = await env.exec("echo hi", { onOutput }, BACKGROUND_CONTEXT);

  expect(okValue(result)).toEqual({ exitCode: 3 });
  expect(chunks).toEqual([
    { stream: "stdout", text: "hi\n" },
    { stream: "stderr", text: "warn\n" },
  ]);
  expect(vm.execCalls).toHaveLength(1);
  expect(vm.execCalls[0]?.command).toBe("echo hi");
  expect(vm.execCalls[0]?.cwd).toBe(WORKDIR);
  expect(vm.execCalls[0]?.maxOutputBytes).toBe(EXEC_OUTPUT_BYTES);
  expect(vm.execCalls[0]?.timeoutMs).toBe(DEFAULT_EXEC_TIMEOUT_MS);
});

test("exec delivers only the non-empty streams", async () => {
  const { env, vm } = setup();
  vm.onExec = () => ({
    exitCode: 0,
    stderr: "",
    stdout: "only\n",
    timedOut: false,
    truncated: false,
  });
  const { chunks, onOutput } = recorder();

  await env.exec("true", { onOutput }, BACKGROUND_CONTEXT);

  expect(chunks).toEqual([{ stream: "stdout", text: "only\n" }]);
});

test("a timed out command gives a timeout error, after its output is delivered", async () => {
  const { env, vm } = setup();
  vm.onExec = () => ({
    exitCode: 124,
    stderr: "",
    stdout: "partial\n",
    timedOut: true,
    truncated: false,
  });
  const { chunks, onOutput } = recorder();

  const result = await env.exec("sleep 999", { onOutput }, BACKGROUND_CONTEXT);

  const error: ExecutionError = errorOf(result);
  expect(error.code).toBe("timeout");
  expect(chunks).toEqual([{ stream: "stdout", text: "partial\n" }]);
});

test("the timeout is seconds to milliseconds, and is clamped to the maximum", async () => {
  const { env, vm } = setup();

  await env.exec("true", { timeout: 5 }, BACKGROUND_CONTEXT);
  expect(vm.execCalls[0]?.timeoutMs).toBe(5000);

  await env.exec("true", { timeout: 1_000_000 }, BACKGROUND_CONTEXT);
  expect(vm.execCalls[1]?.timeoutMs).toBe(MAX_EXEC_TIMEOUT_MS);
});

test("an array command is joined with each argument single-quoted, and the shell reads it back", async () => {
  const { env, vm } = setup();
  const args = ["printf", "%s|", "it's", "a b", "$HOME"];

  await env.exec(args, undefined, BACKGROUND_CONTEXT);

  const [call] = vm.execCalls;
  const command = String(call?.command);
  expect(command).toBe("'printf' '%s|' 'it'\\''s' 'a b' '$HOME'");

  const printed = execFileSync("sh", ["-c", command]).toString();
  expect(printed).toBe("it's|a b|$HOME|");
});

test("exec never adds an environment variable, and inheritEnv is ignored", async () => {
  const { env, vm } = setup();

  await env.exec("env", undefined, BACKGROUND_CONTEXT);
  expect(vm.execCalls[0]?.env).toBeUndefined();

  await env.exec("env", { inheritEnv: true }, BACKGROUND_CONTEXT);
  expect(vm.execCalls[1]?.env).toBeUndefined();

  await env.exec("env", { env: { ONLY: "1" } }, BACKGROUND_CONTEXT);
  expect(vm.execCalls[2]?.env).toEqual({ ONLY: "1" });
});

test("an aborted context refuses exec before the VM is called, and file calls fail as aborted", async () => {
  const { env, vm } = setup();
  const context = abortedContext();

  const result = await env.exec("true", undefined, context);
  expect(errorOf(result).code).toBe("aborted");
  expect(vm.execCalls).toHaveLength(0);

  const read = await env.readTextFile("a.txt", context);
  const error: FileError = errorOf(read);
  expect(error.code).toBe("aborted");
});

test("temporary files and folders are made under /tmp", async () => {
  const { env, vm } = setup();

  const file = okValue(
    await env.createTempFile(
      { prefix: "x-", suffix: ".txt" },
      BACKGROUND_CONTEXT
    )
  );
  expect(file.startsWith("/tmp/x-")).toBe(true);
  expect(file.endsWith(".txt")).toBe(true);
  expect(vm.files.has(file)).toBe(true);

  const dir = okValue(await env.createTempDir("d-", BACKGROUND_CONTEXT));
  expect(dir.startsWith("/tmp/d-")).toBe(true);
  expect(vm.folders.has(dir)).toBe(true);
});

test("watch is refused with not_supported", async () => {
  const { env } = setup();
  const result = await env.watch(
    [{ path: WORKDIR }],
    () => undefined,
    BACKGROUND_CONTEXT
  );
  expect(errorOf(result).code).toBe("not_supported");
});
