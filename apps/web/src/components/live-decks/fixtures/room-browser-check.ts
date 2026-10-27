/** Builds the real client and actual ArtifactRoom test entry, then uses Node to
 * host Miniflare. No production auth, service or route claims are made here. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Deck } from "@repo/live-deck";
import { richTextCodec } from "@repo/live-deck/rich-text";
import tailwindcss from "@tailwindcss/vite";
import { build as bundle, spawn } from "bun";
import { build } from "vite";
import { Doc } from "yjs";
import { emptySlide, newElement } from "../model";

const deck = new Deck(new Doc(), richTextCodec);
deck.setTheme({ colors: {}, fonts: {}, sizes: {} });
for (const id of ["opening", "closing"]) {
  const slide = emptySlide(deck);
  slide.id = id;
  deck.addSlide(slide);
  const text = newElement(deck.read(id).slide, "text");
  text.id = id === "opening" ? "headline" : "ending";
  deck.addElement(id, text);
  if (id === "opening") {
    const shape = newElement(deck.read(id).slide, "shape");
    shape.id = "box";
    shape.props.x = "480";
    deck.addElement(id, shape);
    const table = newElement(deck.read(id).slide, "table");
    table.id = "table";
    table.props.y = "290";
    table.props.h = "180";
    deck.addElement(id, table);
  }
}
const slides = deck.ids().map((id) => deck.readHtml(id).html);
deck.destroy();
deck.doc.destroy();
const output = await mkdtemp(join(tmpdir(), "ld6-room-browser-"));
try {
  const worker = await bundle({
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
        JSON.stringify({
          output,
          script: await worker.outputs[0].text(),
          slides,
          structural: !process.argv.includes("--without-structural"),
        }),
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
