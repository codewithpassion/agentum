import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { agentCommand, createAgentSpawner } from "./agent-process.ts";

const fakeChild = (): ChildProcess =>
  Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  }) as unknown as ChildProcess;

const SDK_OPTIONS = {
  args: [
    "--output-format",
    "stream-json",
    "--append-system-prompt",
    "Be Pelican",
  ],
  command: "/usr/local/bin/claude",
  cwd: "/home/hm-agent/agentum/w1/a1/work",
  env: { HOME: "/home/dom" },
  signal: new AbortController().signal,
};

test("single user starts claude directly in the work dir", () => {
  expect(agentCommand(SDK_OPTIONS, true)).toEqual({
    args: SDK_OPTIONS.args,
    command: SDK_OPTIONS.command,
  });
});

test("multi-user puts sudo -u hm-agent in front and hands the work dir to sudo", () => {
  const { args, command } = agentCommand(SDK_OPTIONS, false);
  expect(command).toBe("sudo");
  expect(args.slice(0, 6)).toEqual([
    "-n",
    "-u",
    "hm-agent",
    "-H",
    "-D",
    SDK_OPTIONS.cwd,
  ]);
  expect(args.slice(6)).toEqual([SDK_OPTIONS.command, ...SDK_OPTIONS.args]);
});

test("multi-user preserves the named variables right after -H and before -D", () => {
  const { args } = agentCommand(SDK_OPTIONS, false, [
    "OPENAI_API_KEY",
    "AGENTUM_RELAY_TOKEN",
  ]);
  expect(args.slice(0, 7)).toEqual([
    "-n",
    "-u",
    "hm-agent",
    "-H",
    "--preserve-env=OPENAI_API_KEY,AGENTUM_RELAY_TOKEN",
    "-D",
    SDK_OPTIONS.cwd,
  ]);
  expect(args.slice(7)).toEqual([SDK_OPTIONS.command, ...SDK_OPTIONS.args]);
});

test("no names means no --preserve-env argument", () => {
  const { args } = agentCommand(SDK_OPTIONS, false, []);
  expect(args.some((arg) => arg.startsWith("--preserve-env"))).toBe(false);
});

test("single user ignores the names and builds the same command", () => {
  expect(agentCommand(SDK_OPTIONS, true, ["OPENAI_API_KEY"])).toEqual(
    agentCommand(SDK_OPTIONS, true)
  );
});

test("the spawner passes the names to sudo but never their values", () => {
  const calls: { args: string[]; env: Record<string, string | undefined> }[] =
    [];
  const spawner = createAgentSpawner({
    preserveEnv: ["OPENAI_API_KEY"],
    singleUser: false,
    spawn: (_command, args, options) => {
      calls.push({ args, env: options.env });
      return fakeChild();
    },
  });
  spawner({
    ...SDK_OPTIONS,
    env: { ...SDK_OPTIONS.env, OPENAI_API_KEY: "fake-openai-value" },
  });
  const [call] = calls;
  if (call === undefined) {
    throw new Error("the spawner did not start sudo");
  }
  expect(call.args).toContain("--preserve-env=OPENAI_API_KEY");
  expect(call.env.OPENAI_API_KEY).toBe("fake-openai-value");
  expect(call.args.join(" ")).not.toContain("fake-openai-value");
});

test("multi-user spawns sudo from / so the daemon user can chdir", () => {
  const calls: { args: string[]; command: string; cwd: string }[] = [];
  const spawner = createAgentSpawner({
    singleUser: false,
    spawn: (command, args, options) => {
      calls.push({ args, command, cwd: options.cwd });
      return fakeChild();
    },
  });
  spawner(SDK_OPTIONS);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.command).toBe("sudo");
  expect(calls[0]?.cwd).toBe("/");
});

test("a real child runs and its stderr reaches onStderr", async () => {
  const seen: string[] = [];
  const spawner = createAgentSpawner({
    onStderr: (text) => seen.push(text),
    singleUser: true,
  });
  const child = spawner({
    args: ["-c", "echo out; echo err 1>&2"],
    command: "sh",
    cwd: "/",
    env: { PATH: process.env.PATH },
    signal: new AbortController().signal,
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });
  // Let the pipes drain after exit.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(stdout).toBe("out\n");
  expect(seen.join("")).toBe("err\n");
});
