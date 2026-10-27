import { build } from "bun";

const built = await build({
  entrypoints: [`${import.meta.dir}/worker.ts`],
  external: ["cloudflare:workers"],
  target: "browser",
});
if (!built.success) {
  throw new Error(built.logs.join("\n"));
}
const [output] = built.outputs;
if (!output) {
  throw new Error("Missing room bundle");
}
process.stdout.write(await output.text());
