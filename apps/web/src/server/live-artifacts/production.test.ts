import { expect, test } from "bun:test";
import { build, spawn } from "bun";

test("production composition: run-token MCP, real room, R2/D1, admission/replay and restart", async () => {
  const built = await build({
    entrypoints: [`${import.meta.dir}/fixtures/production.ts`],
    external: ["cloudflare:workers", "node:*"],
    plugins: [
      {
        name: "unused-browser-driver",
        setup(builder) {
          builder.onResolve({ filter: /^@cloudflare\/playwright$/ }, () => ({
            namespace: "fixture",
            path: "browser-unavailable",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              'export const launch = () => {throw new Error("Browser driver is outside this fixture")}; export const connect = launch;',
            loader: "js",
          }));
        },
      },
    ],
    target: "browser",
  });
  if (!built.success) {
    throw new Error(built.logs.join("\n"));
  }
  const output = built.outputs[0];
  if (!output) {
    throw new Error("Missing bundle");
  }
  const child = spawn(
    ["node", `${import.meta.dir}/fixtures/production-runner.mjs`],
    { stderr: "pipe", stdin: new Blob([await output.text()]), stdout: "pipe" }
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
  ).toBeGreaterThanOrEqual(11);
}, 120_000);
