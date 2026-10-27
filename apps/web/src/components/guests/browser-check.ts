/** Build the production guest entry and drive actual workerd routes/rooms. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";
import { build } from "vite";

const output = await mkdtemp(join(tmpdir(), "guest-browser-assets-"));
try {
  await build({
    build: {
      cssCodeSplit: false,
      emptyOutDir: true,
      outDir: output,
      rolldownOptions: {
        input: resolve(import.meta.dir, "../../guest-entry.tsx"),
        output: { assetFileNames: "guest.[ext]", entryFileNames: "guest.js" },
      },
    },
    configFile: false,
    logLevel: "warn",
    resolve: { alias: { "#": resolve(import.meta.dir, "../..") } },
    root: resolve(import.meta.dir, "../.."),
  });
  const bundler = spawn(
    [
      "bun",
      resolve(
        import.meta.dir,
        "../../server/live-artifacts/fixtures/bundle-guest.ts"
      ),
    ],
    { stderr: "inherit", stdout: "pipe" }
  );
  const script = await new Response(bundler.stdout).text();
  if (await bundler.exited) {
    throw new Error("Guest worker build failed");
  }
  const runner = spawn(
    ["node", resolve(import.meta.dir, "browser-runner.mjs")],
    {
      stderr: "inherit",
      stdin: new Blob([JSON.stringify({ output, script })]),
      stdout: "inherit",
    }
  );
  if (await runner.exited) {
    throw new Error("Guest browser acceptance failed");
  }
} finally {
  await rm(output, { force: true, recursive: true });
}
