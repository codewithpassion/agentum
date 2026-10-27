import { expect, test } from "bun:test";
import { build, spawn } from "bun";

test("Deck authority: two clients, guarded tools, hostile ingress, presenter races and lifecycle in workerd", async () => {
  const built = await build({
    entrypoints: [`${import.meta.dir}/fixtures/worker.ts`],
    external: ["cloudflare:workers"],
    target: "browser",
  });
  if (!built.success) {
    throw new Error(built.logs.join("\n"));
  }
  const [output] = built.outputs;
  if (!output) {
    throw new Error("Missing worker bundle");
  }
  const child = spawn(["node", `${import.meta.dir}/fixtures/deck-runner.mjs`], {
    stderr: "pipe",
    stdin: new Blob([await output.text()]),
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) {
    throw new Error(`${stdout}\n${stderr}`);
  }
  expect(JSON.parse(stdout).passed).toBeGreaterThanOrEqual(25);
}, 120_000);
