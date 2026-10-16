import { expect, test } from "bun:test";
import { spawnCommand } from "./command.ts";

test("stdin is fed to the command and the raw output comes back as bytes", async () => {
  const bytes = new Uint8Array([0, 1, 2, 255, 254, 10]);
  const result = await spawnCommand(["cat"], bytes);
  expect(result.exitCode).toBe(0);
  expect([...(result.stdoutBytes ?? [])]).toEqual([...bytes]);
});

test("text output is decoded and a failing command keeps its exit code and stderr", async () => {
  const ok = await spawnCommand(["echo", "hi"]);
  expect(ok.stdout).toBe("hi\n");
  const failed = await spawnCommand(["ls", "/no/such/path-m19"]);
  expect(failed.exitCode).not.toBe(0);
  expect(failed.stderr).not.toBe("");
});

test("a missing program answers 127 instead of throwing", async () => {
  const result = await spawnCommand(["no-such-program-m19"]);
  expect(result.exitCode).toBe(127);
});
