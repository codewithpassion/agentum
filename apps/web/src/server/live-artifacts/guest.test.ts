import { expect, test } from "bun:test";
import { spawn } from "bun";

test("guest composition: migrated DB, captured mail, two real room clients and revoke", async () => {
  const bundler = spawn(
    ["bun", `${import.meta.dir}/fixtures/bundle-guest.ts`],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [script, bundleErrors, bundleCode] = await Promise.all([
    new Response(bundler.stdout).text(),
    new Response(bundler.stderr).text(),
    bundler.exited,
  ]);
  if (bundleCode !== 0) {
    throw new Error(bundleErrors);
  }
  const child = spawn(
    ["node", `${import.meta.dir}/fixtures/guest-runner.mjs`],
    { stderr: "pipe", stdin: new Blob([script]), stdout: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${stdout}\n${stderr}`);
  }
  expect(
    JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}").passed
  ).toBeGreaterThanOrEqual(30);
}, 120_000);
