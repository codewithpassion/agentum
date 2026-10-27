import { expect, test } from "bun:test";
import { build as bundle, spawn } from "bun";
import { rich } from "./fixtures/rich-text";

test("production deck codec runs rich text and hostile binary admission in actual workerd", async () => {
  const build = await bundle({
    entrypoints: [`${import.meta.dir}/fixtures/workerd.ts`],
    target: "browser",
  });
  expect(build.success).toBe(true);
  const [output] = build.outputs;
  if (!output) {
    throw new Error("Missing worker bundle");
  }
  const child = spawn(
    ["node", `${import.meta.dir}/fixtures/workerd-runner.mjs`],
    { stderr: "pipe", stdin: new Blob([await output.text()]), stdout: "pipe" }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.dom).toBe("undefined");
  expect(result.migrations).toBe(true);
  expect(result.refused).toBe(true);
  expect(result.unchanged).toBe(true);
  expect(result.accepted).toContain("worker ");
  expect(result.cells["0:0"]).toEqual(rich);
}, 20_000);
