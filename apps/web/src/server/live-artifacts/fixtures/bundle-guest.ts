// Build in a separate Bun process: concurrent Bun.build calls in the workspace
// test process otherwise contend over the large production dependency graph.
import { build } from "bun";

const PLAYWRIGHT = /^@cloudflare\/playwright$/;
const ANY_FILE = /.*/;
const built = await build({
  conditions: ["workerd"],
  entrypoints: [`${import.meta.dir}/guest.ts`],
  external: ["cloudflare:workers", "node:*"],
  plugins: [
    {
      name: "unused-browser-driver",
      setup(builder) {
        builder.onResolve({ filter: PLAYWRIGHT }, () => ({
          namespace: "fixture",
          path: "browser-unavailable",
        }));
        builder.onLoad({ filter: ANY_FILE, namespace: "fixture" }, () => ({
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
const [output] = built.outputs;
if (!output) {
  throw new Error("Missing production fixture bundle");
}
process.stdout.write(await output.text());
