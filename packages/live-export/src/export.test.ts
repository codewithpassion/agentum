// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared archive assertions run from both Bun and actual workerd tests.

import { expect, test } from "bun:test";
import { build, spawn } from "bun";
import { strFromU8, unzipSync } from "fflate";
import { Doc, encodeStateAsUpdate, XmlElement, XmlText } from "yjs";
import { assets, deckFixture, docFixture, png } from "./fixtures/content";
import {
  deckPPTX,
  deckPrintHTML,
  documentDOCX,
  documentPrintHTML,
} from "./index";
import { assetLoader, limits } from "./input";

const xml = (zip: Record<string, Uint8Array>, name: string) =>
  strFromU8(zip[name] ?? new Uint8Array());
function checkArchives(word: Uint8Array, ppt: Uint8Array) {
  const d = unzipSync(word),
    p = unzipSync(ppt);
  expect(xml(d, "word/document.xml")).toContain(
    "Export &lt;report&gt; &amp; résumé"
  );
  expect(xml(d, "word/document.xml")).toContain("<w:b/>");
  expect(xml(d, "word/document.xml")).toContain("@Alice");
  expect(xml(d, "word/document.xml")).toContain("w:gridSpan");
  expect(xml(d, "word/numbering.xml")).toContain('w:start w:val="3"');
  expect(xml(d, "word/_rels/document.xml.rels")).toContain("media/");
  expect(
    Object.keys(d).filter((k) => k.startsWith("word/media/")).length
  ).toBeGreaterThan(0);
  expect(xml(p, "ppt/slides/slide1.xml")).toContain("Deck title");
  expect(xml(p, "ppt/slides/slide1.xml")).toContain('x="914400" y="457200"');
  expect(xml(p, "ppt/slides/slide1.xml")).toContain("Cell 4");
  expect(xml(p, "ppt/notesSlides/notesSlide1.xml")).toContain(
    "Speaker notes &lt;safe&gt;"
  );
  expect(xml(p, "ppt/slides/_rels/slide1.xml.rels")).toContain("../media/");
  expect(xml(p, "ppt/presentation.xml")).toContain("12192000");
  for (const archive of [d, p]) {
    for (const [name, bytes] of Object.entries(archive)) {
      if (name.endsWith(".rels")) {
        expect(strFromU8(bytes)).not.toContain('TargetMode="External"');
      }
    }
  }
}
test("real OOXML content, geometry, tables, numbering, assets and relationships", async () => {
  const word = await documentDOCX(docFixture(), assets),
    ppt = await deckPPTX(deckFixture(), assets);
  checkArchives(word.value, ppt.value);
  expect(word.warnings.some((w) => w.code === "pending")).toBe(true);
  expect(ppt.warnings.some((w) => w.code === "element_unsupported")).toBe(true);
});
test("static HTML escapes fields and only includes inert data assets", async () => {
  const d = await documentPrintHTML(docFixture(), assets),
    p = await deckPrintHTML(deckFixture(), assets);
  expect(d.value).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(d.value).not.toContain("<script>");
  expect(d.value).toContain('start="3"');
  expect(d.value).toContain('colspan="2"');
  expect(p.value).toContain("left:96px;top:48px;width:600px;height:100px");
  expect(p.value.match(/class="slide"/g)?.length).toBe(2);
  expect(p.value).toContain("break-after:page");
  expect(p.value).toContain("default-src 'none'");
  expect(p.value).toContain("data:image/png;base64,");
  expect(p.value).not.toContain("http:");
});
test("asset port refuses remote, unowned, active, truncated, corrupt and excessive assets", async () => {
  let calls = 0;
  const port = {
    paths: new Set(["/files/image"]),
    read: () => {
      calls += 1;
      return Promise.resolve({ bytes: png, mime: "image/png" });
    },
  };
  for (const path of [
    "https://evil/image",
    "//evil/image",
    "/files/../image",
    "/files/image?x",
    "data:image/png,hi",
    "/files/other",
  ]) {
    expect(() => assetLoader(port)(path)).toThrow();
  }
  expect(calls).toBe(0);
  const bad = [
    { bytes: png, mime: "image/svg+xml" },
    { bytes: png.subarray(0, 30), mime: "image/png" },
    { bytes: new Uint8Array(limits.asset + 1), mime: "image/png" },
    {
      bytes: png.map((v, i) => (i === 40 ? (v + 1) % 256 : v)),
      mime: "image/png",
    },
  ];
  await Promise.all(
    bad.map((source) =>
      expect(
        assetLoader({ ...port, read: async () => source })("/files/image")
      ).rejects.toThrow()
    )
  );
  const load = assetLoader(port);
  await Promise.all([load("/files/image"), load("/files/image")]);
  expect(calls).toBe(1);
});
test("untrusted Yjs is validated by accepted authority before export", async () => {
  const d = new Doc();
  const node = new XmlElement("paragraph"),
    text = new XmlText();
  text.insert(0, "hostile");
  text.format(0, 7, { script: { src: "https://evil" } });
  node.insert(0, [text]);
  d.getXmlFragment("content").insert(0, [node]);
  await expect(documentDOCX(encodeStateAsUpdate(d), assets)).rejects.toThrow();
  await expect(
    documentPrintHTML(new Uint8Array([1, 2, 3]), assets)
  ).rejects.toThrow();
  await expect(deckPPTX(new Uint8Array([1, 2, 3]), assets)).rejects.toThrow();
  await expect(
    deckPrintHTML(deckFixture(), assets, { height: 720, width: Number.NaN })
  ).rejects.toThrow();
  d.destroy();
});
test("actual workerd generates and round-trips both Office archives without DOM or network", async () => {
  const built = await build({
    entrypoints: [`${import.meta.dir}/fixtures/workerd.ts`],
    target: "browser",
  });
  expect(built.success).toBe(true);
  const [output] = built.outputs;
  if (!output) {
    throw new Error("bundle missing");
  }
  const child = spawn(
    ["node", `${import.meta.dir}/fixtures/workerd-runner.mjs`],
    { stderr: "pipe", stdin: new Blob([await output.text()]), stdout: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const r = JSON.parse(stdout);
  expect(r.dom).toBe("undefined");
  checkArchives(
    Uint8Array.from(atob(r.docx), (c) => c.charCodeAt(0)),
    Uint8Array.from(atob(r.pptx), (c) => c.charCodeAt(0))
  );
}, 30_000);
