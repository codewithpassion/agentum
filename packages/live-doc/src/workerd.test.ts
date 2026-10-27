import { expect, test } from "bun:test";
import { build as bundle, spawn } from "bun";

test("the shared rich schema and markdown/ops/undo run inside workerd without DOM", async () => {
  const build = await bundle({
    entrypoints: [`${import.meta.dir}/fixtures/workerd.ts`],
    target: "browser",
  });
  expect(build.success).toBe(true);
  const [output] = build.outputs;
  if (!output) {
    throw new Error("No worker bundle");
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
  const result = JSON.parse(stdout) as {
    dom: string;
    inserted: string;
    reverted: string;
    outline: { blocks: Array<{ type: string }> };
  };
  expect(result.dom).toBe("undefined");
  expect(result.inserted).toContain("agent");
  expect(result.reverted).not.toContain("agent");
  expect(result.outline.blocks.some((b) => b.type === "table")).toBe(true);
}, 20_000);
