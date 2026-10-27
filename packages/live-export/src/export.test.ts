// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared archive assertions run from both Bun and actual workerd tests.

import { expect, test } from "bun:test";
import { posix } from "node:path";
import { build, spawn } from "bun";
import { strFromU8, unzipSync } from "fflate";
import { SaxesParser } from "saxes";
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  XmlElement,
  XmlText,
  Map as YMap,
} from "yjs";
import {
  assets,
  deckFixture,
  docFixture,
  png,
  pngFor,
} from "./fixtures/content";
import {
  deckPPTX,
  deckPrintHTML,
  documentDOCX,
  documentPrintHTML,
} from "./index";
import { assetLoader, limits } from "./input";

const externalScheme = /^[a-z]+:/i;
const xml = (zip: Record<string, Uint8Array>, name: string) =>
  strFromU8(zip[name] ?? new Uint8Array());
function validateArchive(archive: Record<string, Uint8Array>) {
  for (const [name, bytes] of Object.entries(archive)) {
    if (!(name.endsWith(".xml") || name.endsWith(".rels"))) {
      continue;
    }
    const parser = new SaxesParser();
    parser.on("doctype", () => {
      throw new Error("Unexpected DTD");
    });
    parser.on("opentag", (tag) => {
      if (tag.name !== "Relationship") {
        return;
      }
      const target = String(tag.attributes.Target);
      expect(tag.attributes.TargetMode).not.toBe("External");
      expect(target).not.toMatch(externalScheme);
      const at = name.lastIndexOf("/_rels/");
      const directory = at < 0 ? "" : name.slice(0, at);
      const resolved = posix.normalize(posix.join(directory, target));
      expect(archive[resolved]).toBeDefined();
    });
    parser.write(strFromU8(bytes)).close();
  }
}
function checkArchives(word: Uint8Array, ppt: Uint8Array) {
  const d = unzipSync(word),
    p = unzipSync(ppt);
  validateArchive(d);
  validateArchive(p);
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
  expect(xml(p, "ppt/slides/slide1.xml")).toContain('x="1047750" y="4000500"');
  expect(xml(p, "ppt/theme/theme1.xml")).toContain('typeface="Calibri"');
  expect(xml(p, "ppt/notesSlides/notesSlide1.xml")).toContain(
    "Speaker notes &lt;safe&gt;"
  );
  expect(xml(p, "ppt/slides/_rels/slide1.xml.rels")).toContain("../media/");
  expect(xml(p, "ppt/presentation.xml")).toContain("12192000");
  for (const archive of [d, p]) {
    validateArchive(archive);
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
  expect(p.value).not.toContain('src="http');
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

test("PNG payload decoding, dimensions and repeated image budgets are bounded", async () => {
  const invalid = [
    {
      bytes: pngFor(9000, 1, new Uint8Array([0, 1, 2, 3, 4])),
      code: "export_asset_dimensions",
    },
    {
      bytes: pngFor(1, 1, new Uint8Array(100_000)),
      code: "export_png_inflate_limit",
    },
    {
      bytes: pngFor(1, 1, new Uint8Array([5, 1, 2, 3, 4])),
      code: "export_png_filter",
    },
  ];
  await Promise.all(
    invalid.map((source) =>
      expect(
        assetLoader({
          ...assets,
          read: () =>
            Promise.resolve({ bytes: source.bytes, mime: "image/png" }),
        })("/files/image")
      ).rejects.toThrow(source.code)
    )
  );
  const bytes = pngFor(1024, 1024, new Uint8Array((1024 * 4 + 1) * 1024));
  const load = assetLoader({
    ...assets,
    read: () => Promise.resolve({ bytes, mime: "image/png" }),
  });
  await expect(
    Promise.all(Array.from({ length: 5 }, () => load("/files/image")))
  ).rejects.toThrow("export_asset_reference_limit");
});
test("Office geometry and static mappings are deterministic and source checkpoints stay unchanged", async () => {
  const snapshot = deckFixture(),
    before = snapshot.slice();
  const first = await deckPPTX(snapshot, assets),
    second = await deckPPTX(snapshot, assets);
  const a = unzipSync(first.value),
    b = unzipSync(second.value);
  expect(xml(a, "ppt/slides/slide1.xml")).toBe(xml(b, "ppt/slides/slide1.xml"));
  expect(snapshot).toEqual(before);
  expect((await deckPrintHTML(snapshot, assets)).value).toBe(
    (await deckPrintHTML(snapshot, assets)).value
  );
});
test("snapshot size, malformed binary, illegal XML text and missing mandatory port fail closed", async () => {
  await expect(
    documentDOCX(new Uint8Array(limits.snapshot + 1), assets)
  ).rejects.toThrow("export_byte_limit");
  const d = new Doc();
  const paragraph = new XmlElement("paragraph"),
    text = new XmlText();
  text.insert(0, "bad\u0001text");
  paragraph.insert(0, [text]);
  d.getXmlFragment("content").insert(0, [paragraph]);
  await expect(documentDOCX(encodeStateAsUpdate(d), assets)).rejects.toThrow(
    "export_xml_character"
  );
  d.destroy();
  // @ts-expect-error Exercise the required port boundary from untyped callers.
  await expect(documentDOCX(docFixture(), {})).rejects.toThrow(
    "export_asset_port_required"
  );
});

test("remote image URLs in actual document/deck checkpoints never reach the authorized asset port", async () => {
  let calls = 0;
  const port = {
    paths: assets.paths,
    read: () => {
      calls += 1;
      return Promise.resolve({ bytes: png, mime: "image/png" });
    },
  };
  const urls = [
    "https://evil.example/image.png",
    "//evil.example/image",
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "/files/image?redirect=https://evil.example",
  ];
  await Promise.all(
    urls.map(async (url) => {
      const doc = new Doc(),
        image = new XmlElement("image");
      image.setAttribute("src", url);
      image.setAttribute("alt", "");
      doc.getXmlFragment("content").insert(0, [image]);
      await expect(
        documentPrintHTML(encodeStateAsUpdate(doc), port)
      ).rejects.toThrow();
      doc.destroy();
      const deck = new Doc();
      applyUpdate(deck, deckFixture());
      const slide = deck.getMap("slides").get("s");
      if (!(slide instanceof YMap)) {
        throw new Error("fixture slide missing");
      }
      const elements = slide.get("elements");
      if (!(elements instanceof YMap)) {
        throw new Error("fixture elements missing");
      }
      const imageElement = elements.get("img");
      if (!(imageElement instanceof YMap)) {
        throw new Error("fixture image missing");
      }
      const props = imageElement.get("props");
      if (!(props instanceof YMap)) {
        throw new Error("fixture props missing");
      }
      props.set("src", url);
      await expect(deckPPTX(encodeStateAsUpdate(deck), port)).rejects.toThrow();
      deck.destroy();
    })
  );
  expect(calls).toBe(0);
});

test("asset reads are serialized and a failed asset aborts queued reads", async () => {
  let active = 0,
    peak = 0,
    reads = 0;
  const paths = new Set(["/files/a", "/files/b", "/files/c"]);
  const load = assetLoader({
    paths,
    read: async (path) => {
      reads += 1;
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      if (path === "/files/b") {
        throw new Error("revoked");
      }
      return { bytes: png, mime: "image/png" };
    },
  });
  const results = await Promise.allSettled(
    [...paths].map((path) => load(path))
  );
  expect(results.map((r) => r.status)).toEqual([
    "fulfilled",
    "rejected",
    "rejected",
  ]);
  expect(peak).toBe(1);
  expect(reads).toBe(2);
});
