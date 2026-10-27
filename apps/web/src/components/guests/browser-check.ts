/** Build the production guest entry and drive actual workerd routes/rooms. */
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";
import { build } from "vite";

const output = await mkdtemp(join(tmpdir(), "guest-browser-assets-"));
try {
  if (process.argv.includes("--production-assets")) {
    const assets = resolve(import.meta.dir, "../../../dist/client/assets");
    const name = (await readdir(assets)).find(
      (file) => file.startsWith("guest-entry-") && file.endsWith(".js")
    );
    if (!name) {
      throw new Error("Build the web app before testing production assets");
    }
    await copyFile(join(assets, name), join(output, "guest.js"));
    // The Vite worker URL entry injects its own CSS. The independent build below
    // emits CSS separately, so the fixture shell retains the same stylesheet URL.
    await writeFile(join(output, "guest.css"), "");
  } else {
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
  }
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
