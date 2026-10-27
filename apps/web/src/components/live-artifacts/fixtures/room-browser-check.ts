/** Builds the real client and actual ArtifactRoom test entry, then uses Node to
 * host Miniflare. No production auth, service or route claims are made here. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { build as bundle, spawn } from "bun";
import { build } from "vite";

const output = await mkdtemp(join(tmpdir(), "l8-room-browser-"));
try {
  const worker = await bundle({
    conditions: ["workerd"],
    entrypoints: [
      resolve(
        import.meta.dir,
        "../../../server/live-artifacts/fixtures/worker.ts"
      ),
    ],
    external: ["cloudflare:workers"],
    target: "browser",
  });
  if (!(worker.success && worker.outputs[0])) {
    throw new Error("Could not bundle actual room");
  }
  await build({
    base: "/",
    build: { emptyOutDir: true, outDir: output },
    configFile: false,
    logLevel: "warn",
    plugins: [tailwindcss()],
    resolve: { alias: { "#": resolve(import.meta.dir, "../../..") } },
    root: resolve(import.meta.dir, "room"),
  });
  const child = spawn(
    ["node", resolve(import.meta.dir, "room-browser-runner.mjs")],
    {
      stderr: "inherit",
      stdin: new Blob([
        JSON.stringify({ output, script: await worker.outputs[0].text() }),
      ]),
      stdout: "inherit",
    }
  );
  if ((await child.exited) !== 0) {
    throw new Error("Actual room browser checks failed");
  }
} finally {
  await rm(output, { force: true, recursive: true });
}
