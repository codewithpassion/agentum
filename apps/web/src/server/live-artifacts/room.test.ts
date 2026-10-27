import { expect, test } from "bun:test";
import { spawn } from "bun";

test("ArtifactRoom admission, Yjs validation, SQLite, restart, awareness and checkpoint recovery in workerd", async () => {
  const bundler = spawn(["bun", `${import.meta.dir}/fixtures/bundle-room.ts`], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [script, errors, bundleCode] = await Promise.all([
    new Response(bundler.stdout).text(),
    new Response(bundler.stderr).text(),
    bundler.exited,
  ]);
  if (bundleCode !== 0) {
    throw new Error(errors);
  }
  const child = spawn(["node", `${import.meta.dir}/fixtures/runner.mjs`], {
    stderr: "pipe",
    stdin: new Blob([script]),
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
  expect(JSON.parse(stdout).passed).toBeGreaterThanOrEqual(60);
}, 120_000);
