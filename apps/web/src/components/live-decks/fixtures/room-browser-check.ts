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

const embedSource = `artifact:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:${"a".repeat(64)}:chart.html`;
const deck = new Deck(new Doc(), richTextCodec, {
  ownsBlob: (path) => path === embedSource,
});
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
    shape.props["build-in"] = "fade";
    shape.props["build-order"] = "1";
    shape.props["build-trigger"] = "click";
    deck.addElement(id, shape);
    const embedded = newElement(deck.read(id).slide, "embed");
    embedded.id = "sandbox-chart";
    Object.assign(embedded.props, {
      h: "160",
      src: embedSource,
      w: "250",
      x: "650",
      y: "300",
    });
    deck.addElement(id, embedded);
    const table = newElement(deck.read(id).slide, "table");
    table.id = "table";
    table.props.y = "290";
    table.props.h = "180";
    if (table.cells) {
      table.cells = Object.fromEntries(
        Object.entries(table.cells).filter(([key]) => key !== "0:0")
      );
    }
    deck.addElement(id, table);
  }
}
const slides = deck.ids().map((id) => deck.readHtml(id).html);
deck.destroy();
deck.doc.destroy();
const output = await mkdtemp(join(tmpdir(), "ld6-room-browser-"));
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
        JSON.stringify({
          embedSource,
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
